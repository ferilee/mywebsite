/** @jsx jsx */
/** @jsxFrag Fragment */
import { Fragment, jsx } from 'hono/jsx';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { setCookie, getCookie } from 'hono/cookie';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { db } from './db';
import { projects as projectTable, blogPosts, skills as skillTable, experience as expTable, settings as settingsTable, contacts as contactTable, comments as commentTable, reactions as reactionTable, subscriptions as subTable, pageViews as viewTable, milestones as milestonesTable, activities as activityTable, activityMedia as activityMediaTable, activityLinks as activityLinkTable, participantWorks as participantWorkTable, participantWorkReactions as participantWorkReactionTable, testimonials as testimonialTable, profiles as profileTable, adminNotifications as adminNotificationTable } from './db/schema';
import { eq, desc, or, like, and, inArray, sql } from 'drizzle-orm';
import { Layout } from './components/Layout';
import { AdminLayout } from './components/AdminLayout';
import { marked } from 'marked';
import { z as zod } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

type SessionUser = {
  email: string;
  name: string;
  picture?: string;
  role: 'admin' | 'visitor';
};

interface Env {
  Variables: {
    user: SessionUser | undefined;
    needsProfiling: boolean | undefined;
  };
}

const app = new Hono<Env>();
const adminUpdates = new EventEmitter();

type AdminNotificationInput = {
  type: string;
  title: string;
  message: string;
  href: string;
};

async function createAdminNotification(notification: AdminNotificationInput) {
  try {
    await db.insert(adminNotificationTable).values(notification);
    adminUpdates.emit('update');
  } catch (error) {
    console.error('Admin notification error:', error);
  }
}

async function getAdminNotificationCount() {
  const unread = await db.select({ id: adminNotificationTable.id })
    .from(adminNotificationTable)
    .where(eq(adminNotificationTable.isRead, false));
  return unread.length;
}

app.get('/healthz', (c) => c.json({ ok: true }));

async function ensureColumn(table: string, column: string, definition: string) {
  const columns = await db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) {
    await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`));
  }
}

try {
  await ensureColumn('projects', 'image', 'text');
  await ensureColumn('projects', 'slug', 'text');
  await ensureColumn('projects', 'content', 'text');
  await ensureColumn('projects', 'github', 'text');
  await ensureColumn('blog_posts', 'cover_image', 'text');
  await ensureColumn('activities', 'gallery_album_url', 'text');
  await ensureColumn('activities', 'material_available_from', 'integer');
  await ensureColumn('activities', 'material_available_until', 'integer');
  await ensureColumn('activities', 'certificate_available_from', 'integer');
  await ensureColumn('activities', 'certificate_available_until', 'integer');
  await ensureColumn('activities', 'publication_available_from', 'integer');
  await ensureColumn('activities', 'publication_available_until', 'integer');
  await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS activity_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL REFERENCES activities(id),
    label TEXT NOT NULL,
    url TEXT NOT NULL,
    available_from INTEGER,
    available_until INTEGER,
    sort_order INTEGER DEFAULT 0
  )`));
  await ensureColumn('activity_links', 'available_from', 'integer');
  await ensureColumn('activity_links', 'available_until', 'integer');
  await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS participant_works (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL REFERENCES activities(id),
    title TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    institution TEXT,
    description TEXT,
    preview_image TEXT,
    work_url TEXT,
    tags TEXT,
    status TEXT DEFAULT 'draft',
    consent INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    submitted_at INTEGER,
    created_at INTEGER,
    updated_at INTEGER
  )`));
  await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS participant_work_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id INTEGER NOT NULL REFERENCES participant_works(id),
    visitor_key TEXT NOT NULL,
    created_at INTEGER
  )`));
  await ensureColumn('participant_works', 'view_count', 'integer DEFAULT 0');
  await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS testimonials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_id INTEGER NOT NULL REFERENCES activities(id),
    participant_name TEXT NOT NULL,
    institution TEXT,
    photo_url TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    consent INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  )`));
  await ensureColumn('testimonials', 'photo_url', 'text');
  await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS admin_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    href TEXT NOT NULL,
    is_read INTEGER DEFAULT 0,
    created_at INTEGER
  )`));
} catch (error) {
  console.error('Schema compatibility check failed:', error);
}

// --- MIDDLEWARE ---
app.use('*', async (c, next) => {
  const path = c.req.path;
  // Skip analytics for admin and static files
  if (!path.startsWith('/admin') && !path.startsWith('/static') && !path.startsWith('/auth') && path !== '/healthz') {
    try {
      await db.insert(viewTable)
        .values({ path, count: 1 })
        .onConflictDoUpdate({
          target: viewTable.path,
          set: { count: sql`${viewTable.count} + 1`, lastViewed: new Date() }
        });
    } catch (e) {
      console.error('Analytics error:', e);
    }
  }
  await next();
});

app.use('*', logger());
app.use('*', cors());
app.use('/static/*', serveStatic({
  root: './public',
  rewriteRequestPath: (path) => path.replace(/^\/static/, '')
}));

app.use('*', async (c, next) => {
  const session = getCookie(c, 'user_session');
  if (session) {
    try {
      const user = JSON.parse(decodeURIComponent(session)) as SessionUser;
      c.set('user', user);
      
      // Check profiling for visitors
      if (user.role === 'visitor') {
        const profile = await db.select().from(profileTable).where(eq(profileTable.email, user.email)).limit(1);
        if (profile.length === 0) {
          c.set('needsProfiling', true);
        }
      }
    } catch (e) {
      console.error('Session parse error:', e);
    }
  }
  await next();
});


// --- AUTH MIDDLEWARE ---
app.use('/admin/*', async (c, next) => {
  if (c.req.path === '/admin/login') {
    return await next();
  }
  const user = c.var.user;
  if (!user || user.role !== 'admin') {
    return c.redirect('/admin/login?error=unauthorized');
  }
  await next();
});


// --- API ROUTES ---
app.get('/api/projects', async (c) => c.json(await db.select().from(projectTable)));
app.get('/api/blog', async (c) => c.json(await db.select().from(blogPosts).where(eq(blogPosts.status, 'published'))));
app.get('/api/skills', async (c) => c.json(await db.select().from(skillTable)));

app.get('/api/search', async (c) => {
  const query = c.req.query('q') || '';
  if (!query) return c.json({ projects: [], blog: [], activities: [] });

  const projects = await db.select().from(projectTable)
    .where(or(
      like(projectTable.title, `%${query}%`),
      like(projectTable.description, `%${query}%`),
      like(projectTable.techStack, `%${query}%`)
    ))
    .limit(5);

  const blog = await db.select().from(blogPosts)
    .where(and(
      eq(blogPosts.status, 'published'),
      or(
        like(blogPosts.title, `%${query}%`),
        like(blogPosts.content, `%${query}%`)
      )
    ))
    .limit(5);

  const activities = await db.select().from(activityTable)
    .where(and(
      eq(activityTable.status, 'published'),
      or(
        like(activityTable.title, `%${query}%`),
        like(activityTable.summary, `%${query}%`),
        like(activityTable.category, `%${query}%`),
        like(activityTable.organizer, `%${query}%`)
      )
    ))
    .limit(5);

  return c.json({ projects, blog, activities });
});

app.get('/api/admin/updates', (c) => {
  return streamSSE(c, async (stream) => {
    const listener = () => {
      stream.writeSSE({
        data: 'update',
        event: 'message',
        id: Date.now().toString(),
      });
    };
    adminUpdates.on('update', listener);
    stream.onAbort(() => {
      adminUpdates.off('update', listener);
    });
    // Keep connection alive
    while (true) {
      await stream.sleep(30000);
      await stream.writeSSE({ data: 'ping' });
    }
  });
});

app.get('/api/admin/notifications', async (c) => {
  if (c.var.user?.role !== 'admin') return c.json({ error: 'unauthorized' }, 401);

  const notifications = await db.select().from(adminNotificationTable)
    .orderBy(desc(adminNotificationTable.createdAt))
    .limit(12);
  return c.json({ unreadCount: await getAdminNotificationCount(), notifications });
});

app.post('/api/admin/notifications/read-all', async (c) => {
  if (c.var.user?.role !== 'admin') return c.json({ error: 'unauthorized' }, 401);
  await db.update(adminNotificationTable).set({ isRead: true }).where(eq(adminNotificationTable.isRead, false));
  return c.json({ ok: true, unreadCount: 0 });
});

app.post('/api/admin/notifications/:id/read', async (c) => {
  if (c.var.user?.role !== 'admin') return c.json({ error: 'unauthorized' }, 401);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid_notification' }, 400);
  await db.update(adminNotificationTable).set({ isRead: true }).where(eq(adminNotificationTable.id, id));
  return c.json({ ok: true });
});

app.get('/api/og', async (c) => {
  const title = c.req.query('title') || 'Ferilee Portfolio';
  const category = c.req.query('category') || 'Development';
  
  const svg = `
    <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="#0f0404" />
      <defs>
        <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#2a0b0b" />
          <stop offset="100%" stop-color="#0f0404" />
        </linearGradient>
      </defs>
      <rect width="1200" height="630" fill="url(#g)" />
      <path d="M0 0 L1200 0 L1200 630 L0 630 Z" fill="none" stroke="rgba(220,38,38,0.1)" stroke-width="40" />
      <text x="100" y="150" font-family="sans-serif" font-size="24" font-weight="900" fill="#dc2626" style="text-transform: uppercase; letter-spacing: 5px;">${category}</text>
      <text x="100" y="300" font-family="sans-serif" font-size="80" font-weight="900" fill="white">${title.length > 25 ? title.substring(0, 25) + '...' : title}</text>
      <text x="100" y="530" font-family="sans-serif" font-size="32" font-weight="bold" fill="rgba(255,255,255,0.3)">research.com | ferilee.dev</text>
      <circle cx="1000" cy="315" r="150" fill="#dc2626" fill-opacity="0.1" />
    </svg>
  `;
  
  return c.body(svg, 200, { 'Content-Type': 'image/svg+xml' });
});

// --- PUBLIC PAGES ---

app.get('/', async (c) => {
  const user = c.var.user;
  const allSettings = await db.select().from(settingsTable);
  const settings = Object.fromEntries(allSettings.map(s => [s.key, s.value]));
  
  const heroTitle = settings.hero_title && settings.hero_title !== 'Building <span class="text-red-700 italic">Impact</span><br />Through Code'
    ? settings.hero_title
    : "Membangun <span class=\"text-red-700 italic\">Dampak</span><br />Lewat Kode";
  const heroDesc = settings.hero_desc && settings.hero_desc !== "Hi, I'm Ferilee. I craft high-performance digital experiences that bridge the gap between complex technology and human-centric design."
    ? settings.hero_desc
    : 'Hai, saya Ferilee. Saya merancang pengalaman digital berkinerja tinggi yang menjembatani teknologi kompleks dengan kebutuhan manusia.';
  const philTitle = settings.phil_title && settings.phil_title !== 'Creative<br />Philosophies'
    ? settings.phil_title
    : 'Gagasan<br /><span class="text-red-700">Kreatif</span>';
  const philDesc = settings.phil_desc && settings.phil_desc !== 'Sharing deep dives into fullstack development, architecture, and my journey in the tech industry.'
    ? settings.phil_desc
    : 'Berbagi gagasan tentang pengembangan fullstack, arsitektur teknologi, dan perjalanan saya di dunia digital.';

  const projects = await db.select().from(projectTable).limit(3);
  const skills = await db.select().from(skillTable);
  const experience = await db.select().from(expTable);
  const featuredActivities = await db.select().from(activityTable).where(and(eq(activityTable.status, 'published'), eq(activityTable.featuredOnCv, true))).orderBy(desc(activityTable.eventDate)).limit(3);
  const cvSetting = await db.select().from(settingsTable).where(eq(settingsTable.key, 'cv_url')).limit(1);
  const cvUrl = cvSetting[0]?.value || '#';

  return c.html(
    <Layout title="Ferilee | Portfolio" user={user} needsProfiling={c.var.needsProfiling} currentPath="/">
      <div class="max-w-6xl mx-auto px-6">

        <section class="relative pt-32 pb-20 px-6 md:px-12 min-h-[85vh] flex items-center overflow-hidden">
          <div class="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 items-center gap-12 lg:gap-0 relative">
            <div class="z-20 text-center lg:text-left order-2 lg:order-1">
              <h1 class="text-4xl md:text-6xl font-black mb-6 leading-[1.1] tracking-tight" dangerouslySetInnerHTML={{ __html: heroTitle }}></h1>
              <p class="text-slate-400 text-sm md:text-base max-w-sm mb-10 leading-relaxed mx-auto lg:mx-0">{heroDesc}</p>
              <div class="flex flex-col sm:flex-row justify-center lg:justify-start gap-4">
                <a href="/projects" class="px-10 py-4 bg-red-700 hover:bg-red-800 text-white font-bold rounded-xl btn-shadow transition-all hover:scale-105 active:scale-95 text-center">Lihat Karya</a>
                <a href={cvUrl} target="_blank" class="px-10 py-4 border border-white/10 hover:bg-white/5 text-white font-bold rounded-xl transition-all hover:scale-105 active:scale-95 text-center flex items-center justify-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Unduh CV
                </a>
              </div>
            </div>
            <div class="relative flex justify-center items-center order-1 lg:order-2">
              <div class="absolute w-[300px] md:w-[500px] h-[300px] md:h-[500px] bg-red-900/10 rounded-full blur-[100px] animate-pulse"></div>
              <img src="/static/ferilee.webp" alt="Ferilee Profile" class="relative w-full max-w-[280px] md:max-w-[500px] aspect-[4/5] object-cover scale-105 md:scale-110 lg:scale-125 z-10 brightness-95" style="mask-image: linear-gradient(to bottom, black 80%, transparent 100%); -webkit-mask-image: linear-gradient(to bottom, black 80%, transparent 100%);" />
            </div>
            <div class="z-20 text-center lg:text-right order-3">
              <h2 class="text-4xl md:text-6xl font-black mb-6 leading-[1.1] tracking-tight" dangerouslySetInnerHTML={{ __html: philTitle }}></h2>
              <p class="text-slate-400 text-sm md:text-base max-w-sm mb-10 leading-relaxed mx-auto lg:ml-auto lg:mr-0">{philDesc}</p>
              <div class="flex justify-center lg:justify-end">
                <a href="/blog" class="px-10 py-4 bg-red-900/40 hover:bg-red-900/60 text-white font-bold rounded-xl border border-red-700/30 transition-all hover:scale-105 active:scale-95 text-center">Baca Blog</a>
              </div>
            </div>
          </div>
        </section>
        {featuredActivities.length > 0 && (
          <section class="pb-24 px-6 md:px-12">
            <div class="flex flex-col sm:flex-row justify-between sm:items-end gap-4 mb-8">
              <div><p class="text-xs font-black text-cyan-400 uppercase tracking-[0.3em] mb-3">Kegiatan Pilihan</p><h2 class="text-3xl md:text-4xl font-black italic">JEJAK <span class="text-red-700">PILIHAN</span></h2></div>
              <a href="/jejak" class="text-xs font-black text-slate-400 uppercase tracking-widest hover:text-white">Lihat semua kegiatan →</a>
            </div>
            <div class="grid md:grid-cols-3 gap-5">
              {featuredActivities.map(activity => <a href={`/jejak/${activity.slug}`} class="group bg-white/5 border border-white/10 rounded-3xl overflow-hidden hover:border-cyan-500/40 transition-all"><div class="h-36 bg-gradient-to-br from-red-950 to-slate-950">{activity.coverImage && <img src={activity.coverImage} alt={activity.title} class="w-full h-full object-cover group-hover:scale-105 transition-transform" />}</div><div class="p-5"><p class="text-[10px] text-cyan-400 uppercase tracking-widest font-black">{activity.year} • {activity.role}</p><h3 class="font-bold mt-2 leading-snug">{activity.title}</h3></div></a>)}
            </div>
          </section>
        )}
      </div>
    </Layout>
  );
});

app.get('/projects', async (c) => {
  const user = c.var.user;
  const projects = await db.select().from(projectTable).orderBy(desc(projectTable.id));
  
  // Extract all unique tech tags
  const allTech = [...new Set(projects.flatMap(p => p.techStack?.split(',').map(t => t.trim()) || []))].filter(Boolean);

  return c.html(
    <Layout title="Ferilee | Portofolio" user={user} needsProfiling={c.var.needsProfiling} currentPath="/projects">
      <div class="max-w-6xl mx-auto px-6 py-20">

        <header class="mb-12 text-center">
          <h1 class="text-6xl font-black mb-6 tracking-tight">Karya <span class="text-red-700">Terpilih</span></h1>
          <p class="text-slate-400 max-w-xl mx-auto">Jelajahi perjalanan teknis saya melalui berbagai karya pilihan, mulai dari aplikasi fullstack hingga eksplorasi arsitektur.</p>
        </header>

        {/* Tech Filter */}
        <div class="flex flex-wrap justify-center gap-3 mb-16">
          <button onclick="filterProjects('all')" class="tech-filter-btn active px-6 py-2 rounded-full border border-white/10 text-xs font-bold uppercase tracking-widest bg-white/5 hover:bg-white/10 transition-all">Semua</button>
          {allTech.map(tech => (
            <button 
              onclick={`filterProjects(${JSON.stringify(tech)})`}
              class="tech-filter-btn px-6 py-2 rounded-full border border-white/10 text-xs font-bold uppercase tracking-widest bg-white/5 hover:bg-white/10 transition-all"
            >
              {tech}
            </button>
          ))}
        </div>

        <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-8" id="projects-grid">
          {projects.map(project => (
            <div 
              class="project-card group relative bg-white/5 border border-white/10 rounded-[2rem] overflow-hidden hover:border-red-500/30 transition-all duration-500 hover:-translate-y-2 flex flex-col h-full"
              data-tech={project.techStack}
            >
              <div class="aspect-video w-full overflow-hidden bg-slate-900/70 border-b border-white/5">
                <img
                  src={project.image || `https://images.unsplash.com/photo-1555066931-4365d14bab8c?q=80&w=1200&auto=format&fit=crop`}
                  alt={project.title}
                  class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                />
              </div>
              <div class="p-8 flex flex-col flex-1 min-h-0">
                <h3 class="text-2xl font-bold mb-3">{project.title}</h3>
                <p class="text-slate-400 mb-8 text-sm leading-relaxed" style="display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;">{project.description}</p>
                <div class="flex flex-wrap gap-2 mb-8 max-h-16 overflow-hidden">
                  {project.techStack?.split(',').map(tech => (
                    <span class="px-3 py-1 bg-white/5 border border-white/5 rounded-lg text-[10px] font-bold uppercase tracking-widest text-slate-500">{tech.trim()}</span>
                  ))}
                </div>
                <div class="flex items-center justify-between mt-auto pt-6 border-t border-white/5">
                  <a href={`/projects/${project.slug || project.id}`} class="inline-flex items-center gap-2 text-sm font-bold text-red-500 hover:text-red-400 transition-colors uppercase tracking-widest">Studi Kasus
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                  </a>
                  {project.github && (
                    <a href={project.github} target="_blank" class="text-slate-500 hover:text-white transition-all">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
                    </a>
                  )}
                  {!project.github && (
                    <span class="text-slate-700" aria-hidden="true">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
          function filterProjects(tech) {
            const cards = document.querySelectorAll('.project-card');
            const buttons = document.querySelectorAll('.tech-filter-btn');
            
            buttons.forEach(btn => {
              if (btn.innerText.toLowerCase() === tech.toLowerCase() || (tech === 'all' && btn.innerText.toLowerCase() === 'semua')) {
                btn.classList.add('bg-red-500/20', 'border-red-500/50', 'text-red-500');
              } else {
                btn.classList.remove('bg-red-500/20', 'border-red-500/50', 'text-red-500');
              }
            });

            cards.forEach(card => {
              if (tech === 'all') {
                card.style.display = 'block';
                setTimeout(() => card.style.opacity = '1', 10);
              } else {
                const projectTech = card.getAttribute('data-tech').toLowerCase();
                if (projectTech.includes(tech.toLowerCase())) {
                  card.style.display = 'block';
                  setTimeout(() => card.style.opacity = '1', 10);
                } else {
                  card.style.opacity = '0';
                  setTimeout(() => card.style.display = 'none', 500);
                }
              }
            });
          }
          // Set initial active state
          document.querySelector('.tech-filter-btn').classList.add('bg-red-500/20', 'border-red-500/50', 'text-red-500');
        `}} />
      </div>
    </Layout>
  );
});

app.get('/projects/:slug', async (c) => {
  const user = c.var.user;
  const slug = c.req.param('slug');
  
  const results = await db.select().from(projectTable).where(
    isNaN(parseInt(slug)) ? eq(projectTable.slug, slug) : eq(projectTable.id, parseInt(slug))
  ).limit(1);
  
  const project = results[0];
  if (!project) return c.notFound();

  const contentHtml = await marked.parse(project.content || 'Konten studi kasus akan segera hadir...');
  const ogImage = project.image || `/api/og?title=${encodeURIComponent(project.title)}&category=Studi%20Kasus`;

  return c.html(
    <Layout title={`${project.title} | Studi Kasus`} user={user} ogImage={ogImage} needsProfiling={c.var.needsProfiling} currentPath="/projects">
      <div class="max-w-4xl mx-auto px-6 py-20">
        <header class="mb-16">
          <a href="/projects" class="text-xs font-bold text-slate-500 uppercase tracking-widest hover:text-white transition-all mb-8 block">← Kembali ke Portofolio</a>
          <h1 class="text-6xl font-black mb-6 tracking-tight leading-tight">{project.title}</h1>
          <div class="flex flex-wrap gap-3">
            {project.techStack?.split(',').map(tech => (
              <span class="px-4 py-1.5 bg-red-900/20 border border-red-500/30 rounded-lg text-xs font-bold uppercase tracking-widest text-red-400">{tech.trim()}</span>
            ))}
          </div>
          {project.image && (
            <div class="mt-8 rounded-[2rem] overflow-hidden border border-white/10 bg-white/5 shadow-2xl">
              <img src={project.image} alt={project.title} class="w-full max-h-[60vh] object-cover" />
            </div>
          )}
        </header>

        <div class="grid lg:grid-cols-3 gap-12 mb-20">
          <div class="lg:col-span-2 prose prose-invert prose-red prose-p:text-justify max-w-none text-slate-300 leading-relaxed text-lg" dangerouslySetInnerHTML={{ __html: contentHtml }} />
          <div class="space-y-8">
            <div class="bg-white/5 border border-white/10 rounded-3xl p-8 sticky top-24">
              <h3 class="text-sm font-black text-slate-500 uppercase tracking-widest mb-6">Tautan Cepat</h3>
              <div class="space-y-4">
                {project.link && (
                  <a href={project.link} target="_blank" class="flex items-center justify-between w-full px-6 py-4 bg-red-700 hover:bg-red-800 text-white font-bold rounded-xl transition-all">
                    <span>Pratinjau Langsung</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}
                {project.github && (
                  <a href={project.github} target="_blank" class="flex items-center justify-between w-full px-6 py-4 bg-white/5 border border-white/10 hover:bg-white/10 text-white font-bold rounded-xl transition-all">
                    <span>Repositori</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Live Preview Iframe */}
        {project.link && (
          <div class="mt-20">
            <div class="flex items-center justify-between mb-8">
              <h2 class="text-3xl font-black tracking-tight">Pratinjau <span class="text-red-700">Interaktif</span></h2>
              <span class="text-[10px] font-black text-slate-500 uppercase tracking-widest italic flex items-center gap-2">
                <div class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div> Lingkungan Aktif
              </span>
            </div>
            <div class="bg-white/5 border border-white/10 rounded-[2.5rem] overflow-hidden aspect-video relative group">
              <div class="absolute inset-0 bg-slate-900 flex items-center justify-center z-0">
                <div class="text-slate-700 font-bold italic">Memuat pratinjau...</div>
              </div>
              <iframe 
                src={project.link} 
                class="relative w-full h-full border-none z-10"
                loading="lazy"
              ></iframe>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
});

app.get('/blog', async (c) => {
  const user = c.var.user;
  const posts = await db.select().from(blogPosts).where(eq(blogPosts.status, 'published')).orderBy(desc(blogPosts.createdAt));
  const allComments = await db.select().from(commentTable);
  return c.html(
    <Layout title="Ferilee | Blog" user={user} needsProfiling={c.var.needsProfiling} currentPath="/blog">
      <div class="max-w-6xl mx-auto px-6 py-20">

        <header class="mb-16 text-center">
          <h1 class="text-5xl font-black mb-4">Wawasan & Gagasan</h1>
        </header>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-10">
          {posts.map(post => (
            <article class="group bg-white/5 border border-white/10 rounded-[2.5rem] overflow-hidden hover:border-cyan-500/30 transition-all duration-500 flex flex-col h-full shadow-2xl">
              <div class="aspect-video w-full overflow-hidden relative bg-slate-900">
                <img 
                  src={post.coverImage || `https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1000&auto=format&fit=crop`} 
                  alt={post.title} 
                  class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110 opacity-80 group-hover:opacity-100" 
                />
                <div class="absolute top-4 left-4">
                  <span class="px-4 py-1.5 bg-slate-950/80 backdrop-blur-md border border-white/10 rounded-full text-[10px] font-black text-cyan-400 uppercase tracking-widest">
                    {post.category}
                  </span>
                </div>
              </div>
              <div class="p-8 flex flex-col flex-grow">
                <div class="flex items-center gap-3 mb-4">
                  <span class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                    {new Date(post.createdAt!).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                  <div class="w-1 h-1 bg-slate-700 rounded-full"></div>
                  <span class="text-[10px] text-slate-500 font-bold uppercase tracking-widest">
                    {Math.ceil((post.content?.split(/\s+/).length || 0) / 200)} menit baca
                  </span>
                  <div class="w-1 h-1 bg-slate-700 rounded-full"></div>
                  <span class="text-[10px] text-slate-500 font-bold uppercase tracking-widest flex items-center gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-10.6 8.38 8.38 0 0 1 3.8.9L21 4.5l-1.5 6.5z"/></svg>
                    {allComments.filter(c => c.postId === post.id).length} Komentar
                  </span>
                </div>
                <h2 class="text-2xl font-bold mb-4 line-clamp-2 group-hover:text-cyan-400 transition-colors leading-tight">
                  {post.title}
                </h2>
                <p class="text-slate-400 text-sm leading-relaxed mb-8 line-clamp-3 flex-grow">
                  {post.content.replace(/<[^>]*>?/gm, '').replace(/[#*`]/g, '').substring(0, 160)}...
                </p>
                <div class="pt-6 border-t border-white/5 mt-auto">
                  <a href={`/blog/${post.slug}`} class="inline-flex items-center gap-2 text-xs font-black text-white hover:text-cyan-400 transition-colors uppercase tracking-widest group/btn">
                    Selengkapnya
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="transition-transform duration-300 group-hover/btn:translate-x-1"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
                  </a>
                </div>
              </div>
            </article>
          ))}
        </div>

        {/* Newsletter Section */}
        {c.req.query('subscribed') ? (
          <div class="mt-32 p-12 bg-white/5 border border-white/10 rounded-[3rem] backdrop-blur-xl text-center relative overflow-hidden">
            <div class="absolute -top-24 -right-24 w-64 h-64 bg-green-900/10 rounded-full blur-[100px]"></div>
            <div class="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6 border border-green-500/30">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="text-green-500"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h2 class="text-3xl font-black mb-2 tracking-tight">ANDA <span class="text-green-500">TERDAFTAR!</span></h2>
            <p class="text-slate-400 font-bold uppercase tracking-widest text-xs">Berhasil berlangganan. Terima kasih!</p>
          </div>
        ) : (
          <div class="mt-32 p-6 md:p-12 bg-white/5 border border-white/10 rounded-[3rem] backdrop-blur-xl relative overflow-hidden text-center">
            <div class="absolute -top-24 -left-24 w-64 h-64 bg-cyan-900/10 rounded-full blur-[100px]"></div>
            <h2 class="text-2xl md:text-3xl font-black mb-4 tracking-tight">Tetap <span class="text-cyan-400">Terhubung</span></h2>
            <p class="text-slate-400 mb-8 max-w-md mx-auto">Dapatkan kabar saat saya menerbitkan tulisan baru tentang teknologi, pengembangan, dan perjalanan saya.</p>
            <form action="/subscribe" method="post" class="max-w-md mx-auto flex flex-col sm:flex-row gap-4">
              <input type="email" name="email" placeholder="Alamat email Anda" required class="flex-grow bg-slate-950/50 border border-white/10 rounded-xl px-6 py-4 text-slate-300 focus:outline-none focus:border-cyan-500 transition-all" />
              <button type="submit" class="px-8 py-4 bg-cyan-600 hover:bg-cyan-700 text-white font-black rounded-xl transition-all hover:scale-105 active:scale-95 whitespace-nowrap">Berlangganan</button>
            </form>
          </div>
        )}
      </div>
    </Layout>
  );
});

app.get('/timeline', (c) => c.redirect('/jejak'));

app.get('/api/activities', async (c) => {
  const conditions = [eq(activityTable.status, 'published')];
  const year = Number(c.req.query('year'));
  const category = c.req.query('category');
  if (Number.isInteger(year) && year > 0) conditions.push(eq(activityTable.year, year));
  if (category) conditions.push(eq(activityTable.category, category));

  return c.json(await db.select().from(activityTable).where(and(...conditions)).orderBy(desc(activityTable.eventDate)));
});

function renderParticipantWorkCard(work: any, activity: any = null, reactionCount = 0) {
  const tags = String(work.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  const trackedWorkUrl = work.workUrl ? '/jejak/karya/' + work.id + '/buka' : null;
  const viewCount = Number(work.viewCount || 0);

  return (
    <article data-work-card class="group overflow-hidden rounded-3xl border border-white/10 bg-white/5 transition-all hover:-translate-y-1 hover:border-cyan-500/40">
      <div data-work-preview class="relative aspect-[16/10] overflow-hidden border-b border-white/10 bg-gradient-to-br from-cyan-950/60 to-slate-950">
        {work.previewImage ? <img src={work.previewImage} alt={'Pratinjau ' + work.title} loading="lazy" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden'); this.nextElementSibling.classList.add('flex')" /> : null}
        <div class={(work.previewImage ? 'hidden' : 'flex') + ' absolute inset-0 items-center justify-center overflow-hidden px-6 text-center'} aria-hidden="true">
          <div class="absolute -right-10 -top-12 h-40 w-40 rounded-full bg-cyan-400/15 blur-2xl"></div>
          <div class="absolute -bottom-16 -left-8 h-36 w-36 rounded-full bg-blue-500/20 blur-2xl"></div>
          <div class="relative">
            <span class="block text-3xl font-black italic text-cyan-300/80">K</span>
            <span class="mt-2 block text-[10px] font-black uppercase tracking-[0.25em] text-cyan-400/70">Ruang Karya</span>
          </div>
        </div>
      </div>
      <div data-work-body class="p-5">
        <p class="text-[10px] font-black uppercase tracking-widest text-cyan-400">{work.participantName}</p>
        <h3 class="mt-2 text-xl font-black leading-snug text-white">{work.title}</h3>
        {work.institution && <p class="mt-2 text-xs font-bold text-slate-500">{work.institution}</p>}
        {activity && <p class="mt-2 text-xs font-bold text-slate-500">{activity.title}</p>}
        {work.description && <p class="mt-4 line-clamp-3 text-justify text-sm leading-relaxed text-slate-400">{work.description}</p>}
        {tags.length > 0 && <div class="mt-4 flex flex-wrap gap-2">{tags.map(tag => <span class="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-400">{tag}</span>)}</div>}
        <div data-work-meta class="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-bold text-slate-500">
          <span class="inline-flex items-center gap-1.5" title="Jumlah apresiasi"><span class="text-cyan-300" aria-hidden="true">♥</span><span data-applause-count>{reactionCount}</span><span>apresiasi</span></span>
          {trackedWorkUrl && <span class="inline-flex items-center gap-1.5" title="Jumlah pembukaan karya"><span aria-hidden="true">↗</span><span>{viewCount}</span><span>dibuka</span></span>}
        </div>
        <div data-work-actions class="mt-5 flex flex-wrap items-center gap-3">
          {trackedWorkUrl ? <a href={trackedWorkUrl} target="_blank" rel="noreferrer" class="rounded-xl bg-cyan-700 px-4 py-2.5 text-xs font-black uppercase tracking-widest text-white transition-colors hover:bg-cyan-800">Lihat Karya ↗</a> : <span class="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-bold text-slate-600">Belum ada tautan karya</span>}
          {activity && <a href={'/jejak/' + activity.slug + '#karya-peserta'} class="text-xs font-bold text-slate-500 transition-colors hover:text-white">Lihat Aktivitas ↗</a>}
          <button type="button" data-applause-button data-work-id={work.id} aria-label="Apresiasi karya" aria-pressed="false" onclick={'applaudWork(this, ' + work.id + ')'} class="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs font-black text-slate-400 transition-all hover:border-cyan-400/40 hover:text-cyan-300"><span aria-hidden="true">♥</span><span data-applause-label>Apresiasi</span><span class="sr-only"> karya</span></button>
        </div>
      </div>
    </article>
  );
}

function renderParticipantWorkReactionScript() {
  return <script dangerouslySetInnerHTML={{ __html: `
    window.applaudWork = async (button, workId) => {
      if (button.dataset.loading === 'true') return;
      button.dataset.loading = 'true';
      try {
        const response = await fetch('/api/participant-works/' + workId + '/applause', { method: 'POST', headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Reaction failed');
        const count = button.querySelector('[data-applause-count]');
        if (count) count.textContent = String(data.applause);
        button.setAttribute('aria-pressed', String(data.reacted));
        button.classList.toggle('border-cyan-400/60', data.reacted);
        button.classList.toggle('bg-cyan-500/15', data.reacted);
        button.classList.toggle('text-cyan-300', data.reacted);
        const label = button.querySelector('[data-applause-label]');
        if (label) label.textContent = 'Sudah diapresiasi';
        button.title = 'Anda sudah mengapresiasi karya ini';
        button.disabled = true;
      } catch (error) {
        button.title = 'Apresiasi gagal. Coba lagi.';
      } finally {
        button.dataset.loading = 'false';
      }
    };
  `}} />;
}

function renderTestimonialCard(testimonial: any) {
  return <article class="rounded-2xl border border-white/10 bg-white/5 p-5"><div class="flex items-start gap-3">{testimonial.photoUrl ? <img src={testimonial.photoUrl} alt={testimonial.participantName} loading="lazy" class="h-10 w-10 shrink-0 rounded-xl object-cover" /> : <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-sm font-black text-red-300">{String(testimonial.participantName || '?').charAt(0).toUpperCase()}</div>}<div class="min-w-0"><p class="font-black text-white">{testimonial.participantName}</p>{testimonial.institution && <p class="mt-1 truncate text-xs font-bold text-slate-500">{testimonial.institution}</p>}</div></div><p class="mt-4 text-sm leading-relaxed text-slate-300">“{testimonial.content}”</p></article>;
}

function renderTestimonialSubmission(c: any, activity: any) {
  const query = c.req.query();
  const destination = `/jejak/${activity.slug}/testimoni`;
  return c.html(
    <Layout title={`Bagikan Pengalaman | ${activity.title}`} user={c.var.user} needsProfiling={c.var.needsProfiling} currentPath="/jejak">
      <div class="mx-auto max-w-3xl px-6 py-28 md:py-32"><a href={`/jejak/${activity.slug}#testimoni`} class="text-xs font-black uppercase tracking-widest text-red-500 transition-colors hover:text-white">← Kembali ke aktivitas</a><header class="mt-8 border-b border-white/10 pb-8"><p class="text-xs font-black uppercase tracking-[0.3em] text-cyan-400">Pengalaman Peserta</p><h1 class="mt-4 text-4xl font-black italic tracking-tight md:text-6xl">BAGIKAN <span class="text-cyan-400">PENGALAMAN</span></h1><p class="mt-5 leading-relaxed text-slate-400">Ceritakan pengalaman Anda mengikuti <strong class="text-slate-200">{activity.title}</strong>. Testimoni akan ditinjau sebelum ditampilkan secara publik.</p></header>{query.submitted && <div class="mt-8 rounded-2xl border border-green-500/20 bg-green-500/10 p-5 text-sm leading-relaxed text-green-200">Terima kasih. Testimoni Anda sudah diterima dan menunggu moderasi.</div>}{query.error && <div class="mt-8 rounded-2xl border border-red-500/20 bg-red-500/10 p-5 text-sm leading-relaxed text-red-200">{query.error === 'upload' ? 'Foto gagal diunggah. Pastikan formatnya JPG, PNG, atau WebP dan ukurannya maksimal 5 MB.' : 'Mohon lengkapi nama, testimoni, dan persetujuan publikasi.'}</div>}<form action={destination} method="post" enctype="multipart/form-data" class="mt-8 space-y-5 rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl sm:p-8"><input type="text" name="website" tabIndex={-1} autoComplete="off" class="hidden" aria-hidden="true" /><div class="grid gap-5 sm:grid-cols-2"><input type="text" name="participantName" placeholder="Nama Anda" required maxLength={100} class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none" /><input type="text" name="institution" placeholder="Institusi (opsional)" maxLength={150} class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none" /></div><div class="space-y-2"><label class="block text-[10px] font-black uppercase tracking-widest text-slate-500">Foto Profil (opsional)</label><input type="file" name="photoFile" accept="image/jpeg,image/png,image/webp" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white" /><p class="text-xs leading-relaxed text-slate-500">JPG, PNG, atau WebP. Maksimal 5 MB; otomatis dikonversi ke WebP.</p></div><textarea name="content" placeholder="Ceritakan pengalaman Anda..." required minLength={20} maxLength={1000} class="min-h-40 w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-4 text-sm leading-relaxed text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"></textarea><label class="flex items-start gap-3 rounded-xl border border-white/10 bg-slate-950/40 p-4 text-xs leading-relaxed text-slate-400"><input type="checkbox" name="consent" required class="mt-0.5 h-4 w-4 shrink-0 accent-cyan-500" /> Saya menyetujui nama, foto, institusi, dan testimoni ini ditampilkan pada website.</label><button type="submit" class="w-full rounded-xl bg-cyan-700 px-5 py-4 text-xs font-black uppercase tracking-widest text-white transition-colors hover:bg-cyan-800">Kirim Testimoni untuk Ditinjau</button></form></div>
    </Layout>
  );
}

async function getParticipantWorkReactionCounts() {
  const reactions = await db.select().from(participantWorkReactionTable);
  const counts = new Map<number, number>();
  for (const reaction of reactions) counts.set(reaction.workId, (counts.get(reaction.workId) || 0) + 1);
  return counts;
}

app.post('/api/participant-works/:id/applause', async (c) => {
  const workId = Number(c.req.param('id'));
  if (!Number.isInteger(workId) || workId <= 0) return c.json({ error: 'Invalid work' }, 400);

  const work = await db.select().from(participantWorkTable).where(and(
    eq(participantWorkTable.id, workId),
    eq(participantWorkTable.status, 'published'),
    eq(participantWorkTable.consent, true),
  )).limit(1);
  if (!work[0]) return c.json({ error: 'Work not found' }, 404);

  const user = c.var.user;
  const existingCookie = getCookie(c, 'work_reaction_key');
  const reactionVisitorKey = user?.email
    ? `user:${user.email.toLowerCase()}`
    : `visitor:${existingCookie || crypto.randomUUID()}`;

  if (!user && !existingCookie) {
    setCookie(c, 'work_reaction_key', reactionVisitorKey.slice('visitor:'.length), {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  const existingReaction = await db.select().from(participantWorkReactionTable).where(and(
    eq(participantWorkReactionTable.workId, workId),
    eq(participantWorkReactionTable.visitorKey, reactionVisitorKey),
  )).limit(1);
  if (!existingReaction[0]) {
    await db.insert(participantWorkReactionTable).values({ workId, visitorKey: reactionVisitorKey });
  }

  const reactions = await db.select().from(participantWorkReactionTable).where(eq(participantWorkReactionTable.workId, workId));
  return c.json({ applause: reactions.length, reacted: true });
});

app.get('/jejak/karya/:id/buka', async (c) => {
  const workId = Number(c.req.param('id'));
  if (!Number.isInteger(workId) || workId <= 0) return c.notFound();

  const work = await db.select().from(participantWorkTable).where(and(
    eq(participantWorkTable.id, workId),
    eq(participantWorkTable.status, 'published'),
    eq(participantWorkTable.consent, true),
  )).limit(1);
  const targetUrl = work[0]?.workUrl;
  if (!targetUrl) return c.notFound();

  await db.update(participantWorkTable)
    .set({ viewCount: sql`COALESCE(${participantWorkTable.viewCount}, 0) + 1` })
    .where(eq(participantWorkTable.id, workId));

  return c.redirect(targetUrl, 302);
});

app.get('/jejak/karya', async (c) => {
  const user = c.var.user;
  const selectedCategory = c.req.query('category') || '';
  const selectedSort = c.req.query('sort') === 'applause' ? 'applause' : 'latest';
  const activities = await db.select({ id: activityTable.id, title: activityTable.title, slug: activityTable.slug }).from(activityTable).where(eq(activityTable.status, 'published'));
  const works = await db.select().from(participantWorkTable).where(and(eq(participantWorkTable.status, 'published'), eq(participantWorkTable.consent, true))).orderBy(desc(participantWorkTable.createdAt));
  const activitiesById = new Map(activities.map(activity => [activity.id, activity]));
  const reactionCounts = await getParticipantWorkReactionCounts();
  const workItems = works.filter(work => work.title && work.participantName && activitiesById.has(work.activityId)).map(work => ({
    work,
    activity: activitiesById.get(work.activityId),
    tags: String(work.tags || '').split(',').map(tag => tag.trim()).filter(Boolean),
    applause: reactionCounts.get(work.id) || 0,
  }));
  const categories = [...new Set(workItems.flatMap(item => item.tags))].sort((a, b) => a.localeCompare(b));
  const publicWorks = workItems
    .filter(item => !selectedCategory || item.tags.some(tag => tag.toLowerCase() === selectedCategory.toLowerCase()))
    .sort((a, b) => selectedSort === 'applause'
      ? b.applause - a.applause || new Date(b.work.createdAt || 0).getTime() - new Date(a.work.createdAt || 0).getTime()
      : new Date(b.work.createdAt || 0).getTime() - new Date(a.work.createdAt || 0).getTime());

  return c.html(
    <Layout title="Karya Peserta | Jejak Ferilee" user={user} needsProfiling={c.var.needsProfiling} currentPath="/jejak">
      <div class="mx-auto max-w-7xl px-6 py-28 md:py-32">
        <div class="mx-auto max-w-5xl"><a href="/jejak" class="text-xs font-black uppercase tracking-widest text-red-500 transition-colors hover:text-white">← Kembali ke Jejak</a><header class="mt-8 border-b border-white/10 pb-10"><p class="text-xs font-black uppercase tracking-[0.35em] text-cyan-400">Ruang Karya Peserta</p><div class="mt-4 flex flex-col gap-6 md:flex-row md:items-end md:justify-between"><div><h1 class="text-5xl font-black italic tracking-tight md:text-7xl">KARYA <span class="text-cyan-400">PESERTA</span></h1><p class="mt-5 max-w-2xl text-lg leading-relaxed text-slate-400">Kumpulan karya belajar, eksplorasi, dan praktik peserta dalam berbagai workshop.</p></div><div class="flex shrink-0 rounded-xl border border-white/10 bg-white/5 p-1"><button type="button" data-showcase-view="cards" onclick="setShowcaseView('cards')" class="rounded-lg px-3 py-2 text-xs font-black text-slate-400 transition-colors hover:text-white" aria-pressed="true">▦ Kartu</button><button type="button" data-showcase-view="list" onclick="setShowcaseView('list')" class="rounded-lg px-3 py-2 text-xs font-black text-slate-400 transition-colors hover:text-white" aria-pressed="false">☷ Daftar</button></div></div></header></div>
        <form action="/jejak/karya" method="get" class="mx-auto mt-8 flex max-w-5xl flex-col gap-3 sm:flex-row"><select name="category" class="rounded-xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-300"><option value="">Semua kategori</option>{categories.map(category => <option value={category} selected={category === selectedCategory}>{category}</option>)}</select><select name="sort" class="rounded-xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-300"><option value="latest" selected={selectedSort === 'latest'}>Terbaru</option><option value="applause" selected={selectedSort === 'applause'}>Paling diapresiasi</option></select><button type="submit" class="rounded-xl bg-cyan-700 px-5 py-3 text-xs font-black uppercase tracking-widest text-white transition-colors hover:bg-cyan-800">Terapkan</button></form>
        {publicWorks.length > 0 ? <div id="participant-showcase-grid" data-showcase-grid class="mx-auto mt-8 grid max-w-5xl gap-5 md:grid-cols-2 lg:grid-cols-3">{publicWorks.map(item => renderParticipantWorkCard(item.work, item.activity, item.applause))}</div> : <div class="mx-auto mt-12 max-w-5xl rounded-3xl border border-dashed border-white/10 bg-white/5 p-16 text-center"><p class="text-sm font-bold text-slate-500">Belum ada karya peserta yang cocok dengan filter ini.</p><a href="/jejak" class="mt-6 inline-flex rounded-xl border border-white/10 px-5 py-3 text-xs font-black uppercase tracking-widest text-slate-400 transition-colors hover:text-white">Jelajahi Jejak</a></div>}
        <style>{`[data-showcase-grid].list-view{display:flex;flex-direction:column}[data-showcase-grid].list-view [data-work-card]{display:grid;grid-template-columns:180px minmax(0,1fr)}[data-showcase-grid].list-view [data-work-preview]{height:100%;min-height:180px;aspect-ratio:auto;border-bottom:0;border-right:1px solid rgba(255,255,255,.1)}[data-showcase-grid].list-view [data-work-body]{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem 1rem}[data-showcase-grid].list-view [data-work-body]>p,[data-showcase-grid].list-view [data-work-body]>h3,[data-showcase-grid].list-view [data-work-body]>div:not([data-work-actions]){width:100%}[data-showcase-grid].list-view [data-work-actions]{margin-top:1rem;width:100%}@media(max-width:639px){[data-showcase-grid].list-view [data-work-card]{grid-template-columns:100px minmax(0,1fr)}[data-showcase-grid].list-view [data-work-preview]{min-height:150px}}`}</style>
        <script dangerouslySetInnerHTML={{ __html: `
          (() => {
            const grid = document.querySelector('[data-showcase-grid]');
            const buttons = document.querySelectorAll('[data-showcase-view]');
            const applyView = (view) => {
              grid?.classList.toggle('list-view', view === 'list');
              buttons.forEach(button => {
                const active = button.dataset.showcaseView === view;
                button.setAttribute('aria-pressed', String(active));
                button.classList.toggle('bg-cyan-500/15', active);
                button.classList.toggle('text-cyan-300', active);
              });
              try { localStorage.setItem('participant-showcase-view', view); } catch (error) {}
            };
            window.setShowcaseView = applyView;
            let initialView = 'cards';
            try { initialView = localStorage.getItem('participant-showcase-view') || 'cards'; } catch (error) {}
            applyView(initialView === 'list' ? 'list' : 'cards');
          })();
        `}} />
        {renderParticipantWorkReactionScript()}
      </div>
    </Layout>
  );
});

app.get('/jejak/:slug/kirim-karya', async (c) => {
  const results = await db.select().from(activityTable).where(and(eq(activityTable.slug, c.req.param('slug')), eq(activityTable.status, 'published'))).limit(1);
  const activity = results[0];
  if (!activity) return c.notFound();
  return renderParticipantSubmission(c, activity);
});

app.post('/jejak/:slug/kirim-karya', async (c) => {
  const results = await db.select().from(activityTable).where(and(eq(activityTable.slug, c.req.param('slug')), eq(activityTable.status, 'published'))).limit(1);
  const activity = results[0];
  if (!activity) return c.notFound();
  const body = await c.req.parseBody();
  const destination = `/jejak/${activity.slug}/kirim-karya`;

  if (String(body.website || '').trim()) return c.redirect(`${destination}?submitted=1`);

  const title = String(body.title || '').trim();
  const participantName = String(body.participantName || '').trim();
  const consent = body.consent === 'on' || body.consent === 'true';
  const workUrl = normalizeHttpUrl(String(body.workUrl || '').trim());
  const previewImageUrl = normalizeHttpUrl(String(body.previewImage || '').trim());
  const previewImageFile = body.previewImageFile;
  const previewFile = previewImageFile instanceof File && previewImageFile.size > 0 ? previewImageFile : null;
  const hasPreviewUpload = Boolean(previewFile);

  if (!title || !participantName) return c.redirect(`${destination}?error=fields`);
  if (!consent) return c.redirect(`${destination}?error=consent`);
  if (!workUrl && !previewImageUrl && !hasPreviewUpload) return c.redirect(`${destination}?error=evidence`);

  let previewImage = previewImageUrl;
  if (previewFile) {
    try {
      previewImage = await uploadToS3(previewFile, 'participant-work-previews');
    } catch (error) {
      console.error('Participant preview upload failed:', error);
      return c.redirect(`${destination}?error=upload`);
    }
  }

  await db.insert(participantWorkTable).values({
    activityId: activity.id,
    title,
    participantName,
    institution: String(body.institution || '').trim() || null,
    description: String(body.description || '').trim() || null,
    previewImage,
    workUrl,
    tags: String(body.tags || '').trim() || null,
    status: 'draft',
    consent: true,
    submittedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await createAdminNotification({
    type: 'participant_work',
    title: 'Karya baru menunggu tinjauan',
    message: `${participantName} mengirim karya “${title}”.`,
    href: '/admin/works',
  });
  return c.redirect(`${destination}?submitted=1`);
});

app.get('/jejak/:slug/testimoni', async (c) => {
  const results = await db.select().from(activityTable).where(and(eq(activityTable.slug, c.req.param('slug')), eq(activityTable.status, 'published'))).limit(1);
  const activity = results[0];
  if (!activity) return c.notFound();
  return renderTestimonialSubmission(c, activity);
});

app.post('/jejak/:slug/testimoni', async (c) => {
  const results = await db.select().from(activityTable).where(and(eq(activityTable.slug, c.req.param('slug')), eq(activityTable.status, 'published'))).limit(1);
  const activity = results[0];
  if (!activity) return c.notFound();
  const body = await c.req.parseBody();
  const destination = `/jejak/${activity.slug}/testimoni`;
  if (String(body.website || '').trim()) return c.redirect(`${destination}?submitted=1`);

  const participantName = String(body.participantName || '').trim();
  const institution = String(body.institution || '').trim();
  const content = String(body.content || '').trim();
  const consent = body.consent === 'on' || body.consent === 'true';
  const photoFile = body.photoFile instanceof File && body.photoFile.size > 0 ? body.photoFile : null;
  if (participantName.length < 2 || participantName.length > 100 || institution.length > 150 || content.length < 20 || content.length > 1000 || !consent) {
    return c.redirect(`${destination}?error=fields`);
  }

  let photoUrl: string | null = null;
  if (photoFile && photoFile.size > 5 * 1024 * 1024) {
    return c.redirect(`${destination}?error=upload`);
  }
  if (photoFile) {
    try {
      photoUrl = await uploadToS3(photoFile, 'testimonial-photos');
    } catch (error) {
      console.error('Testimonial photo upload failed:', error);
      return c.redirect(`${destination}?error=upload`);
    }
  }

  await db.insert(testimonialTable).values({
    activityId: activity.id,
    participantName,
    institution: institution || null,
    photoUrl,
    content,
    status: 'draft',
    consent: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await createAdminNotification({
    type: 'testimonial',
    title: 'Testimoni baru menunggu moderasi',
    message: `${participantName} membagikan pengalaman kegiatan.`,
    href: '/admin/testimonials',
  });
  return c.redirect(`${destination}?submitted=1`);
});

app.get('/jejak', async (c) => {
  const user = c.var.user;
  const selectedYear = c.req.query('year') || '';
  const selectedCategory = c.req.query('category') || '';
  const publishedCondition = eq(activityTable.status, 'published');
  const allActivities = await db.select().from(activityTable).where(publishedCondition).orderBy(desc(activityTable.eventDate));
  const milestones = await db.select().from(milestonesTable).orderBy(desc(milestonesTable.year));
  const testimonials = await db.select().from(testimonialTable).where(and(eq(testimonialTable.status, 'published'), eq(testimonialTable.consent, true))).orderBy(desc(testimonialTable.createdAt)).limit(3);
  const years = [...new Set(allActivities.map(activity => activity.year))].sort((a, b) => b - a);
  const categories = [...new Set(allActivities.map(activity => activity.category))].sort();
  const filteredActivities = allActivities.filter(activity =>
    (!selectedYear || String(activity.year) === selectedYear) &&
    (!selectedCategory || activity.category === selectedCategory)
  );
  const featuredActivities = allActivities.filter(activity => activity.featuredOnCv).slice(0, 3);
  const groupedActivities = new Map<number, typeof filteredActivities>();
  for (const activity of filteredActivities) {
    const current = groupedActivities.get(activity.year) || [];
    current.push(activity);
    groupedActivities.set(activity.year, current);
  }

  return c.html(
    <Layout title="Ferilee | Jejak" user={user} needsProfiling={c.var.needsProfiling} currentPath="/jejak">
      <div class="max-w-7xl mx-auto px-6 py-28 md:py-32">
        <header class="max-w-4xl mx-auto text-center mb-16">
          <p class="text-xs font-black text-red-500 uppercase tracking-[0.35em] mb-5">Jurnal Kegiatan Profesional</p>
          <h1 class="text-5xl md:text-7xl font-black tracking-tight italic">JEJAK <span class="text-red-700">FERI LEE</span></h1>
          <p class="text-slate-400 text-lg max-w-2xl mx-auto mt-6 leading-relaxed">Belajar • Berbagi • Berkolaborasi • Berdampak</p>
          <p class="text-slate-500 max-w-2xl mx-auto mt-3 leading-relaxed">Dokumentasi perjalanan berbagi, mendampingi, dan bertumbuh bersama pendidik Indonesia.</p>
          <a href="/jejak/karya" class="mt-8 inline-flex rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-5 py-3 text-xs font-black uppercase tracking-widest text-cyan-300 transition-all hover:bg-cyan-500/20 hover:text-white">Lihat Karya Peserta ↗</a>
        </header>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-5xl mx-auto mb-20">
          {[
            { label: 'Kegiatan', value: allActivities.length },
            { label: 'Tahun aktif', value: years.length },
            { label: 'Kategori', value: categories.length },
            { label: 'Pilihan', value: featuredActivities.length },
          ].map(stat => (
            <div class="bg-white/5 border border-white/10 rounded-2xl p-5 text-center backdrop-blur-xl">
              <p class="text-2xl md:text-3xl font-black text-white">{stat.value}+</p>
              <p class="text-[10px] text-slate-500 uppercase tracking-widest font-black mt-2">{stat.label}</p>
            </div>
          ))}
        </div>

        {featuredActivities.length > 0 && (
          <section class="max-w-5xl mx-auto mb-20">
            <div class="flex items-center justify-between mb-6">
              <h2 class="text-2xl md:text-3xl font-black italic">JEJAK <span class="text-red-700">PILIHAN</span></h2>
              <span class="text-[10px] text-slate-500 uppercase tracking-widest font-black">Pilihan untuk CV</span>
            </div>
            <div class="grid md:grid-cols-3 gap-5">
              {featuredActivities.map(activity => (
                <a href={`/jejak/${activity.slug}`} class="group bg-white/5 border border-white/10 rounded-3xl overflow-hidden hover:border-red-500/40 transition-all">
                  {activity.coverImage ? <img src={activity.coverImage} alt={activity.title} class="w-full h-40 object-cover group-hover:scale-105 transition-transform" /> : <div class="h-40 bg-gradient-to-br from-red-950 to-slate-950"></div>}
                  <div class="p-5">
                    <p class="text-[10px] text-red-500 uppercase tracking-widest font-black">{activity.year} • {activity.role}</p>
                    <h3 class="font-bold mt-2 leading-snug">{activity.title}</h3>
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}

        {testimonials.length > 0 && (
          <section class="mx-auto mb-20 max-w-5xl"><div class="mb-6 flex items-end justify-between gap-4"><div><p class="text-xs font-black uppercase tracking-[0.3em] text-cyan-400">Apa Kata Peserta</p><h2 class="mt-2 text-2xl font-black italic md:text-3xl">SUARA <span class="text-cyan-400">PESERTA</span></h2></div><span class="text-[10px] font-black uppercase tracking-widest text-slate-500">Pengalaman nyata</span></div><div class="grid gap-5 md:grid-cols-3">{testimonials.map(testimonial => renderTestimonialCard(testimonial))}</div></section>
        )}

        <section class="max-w-5xl mx-auto">
          <div class="flex flex-col lg:flex-row lg:items-end justify-between gap-6 mb-10">
            <div>
              <h2 class="text-3xl md:text-4xl font-black italic">LINIMASA <span class="text-red-700">KEGIATAN</span></h2>
              <p class="text-slate-500 mt-2">Pilih tahun atau kategori untuk menelusuri perjalanan.</p>
            </div>
            <form action="/jejak" method="get" class="flex flex-col sm:flex-row gap-3">
              <select name="year" class="bg-slate-950/70 border border-white/10 rounded-xl px-4 py-3 text-sm text-slate-300">
                <option value="">Semua tahun</option>
                {years.map(year => <option value={year} selected={String(year) === selectedYear}>{year}</option>)}
              </select>
              <select name="category" class="bg-slate-950/70 border border-white/10 rounded-xl px-4 py-3 text-sm text-slate-300">
                <option value="">Semua kategori</option>
                {categories.map(category => <option value={category} selected={category === selectedCategory}>{category}</option>)}
              </select>
              <button type="submit" class="px-5 py-3 bg-red-700 hover:bg-red-800 rounded-xl text-xs font-black uppercase tracking-widest">Filter</button>
            </form>
          </div>

          {filteredActivities.length > 0 ? (
            <div class="space-y-14">
              {Array.from(groupedActivities.entries()).map(([year, activities]) => (
                <section>
                  <div class="flex items-center gap-4 mb-6"><span class="text-3xl md:text-4xl font-black text-red-500">{year}</span><div class="h-px bg-white/10 flex-1"></div></div>
                  <div class="grid md:grid-cols-2 gap-5">
                    {activities.map(activity => {
                      const fallbackCover = `/api/og?title=${encodeURIComponent(activity.title)}&category=${encodeURIComponent(activity.category)}`;
                      const coverImage = activity.coverImage || fallbackCover;
                      return <a href={`/jejak/${activity.slug}`} class="group overflow-hidden rounded-3xl border border-white/10 bg-white/5 transition-all hover:-translate-y-1 hover:border-red-500/40">
                        <div class="relative h-44 overflow-hidden border-b border-white/10 bg-gradient-to-br from-red-950 to-slate-950">
                          <img src={coverImage} alt={activity.title} loading="lazy" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
                          <div class="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/70 via-transparent to-transparent"></div>
                        </div>
                        <div class="p-6">
                          <div class="flex items-start justify-between gap-4">
                            <div><p class="text-[10px] text-red-500 uppercase tracking-widest font-black">{activity.category}</p><h3 class="text-xl font-black mt-2 leading-snug">{activity.title}</h3></div>
                            <span class="text-slate-600 group-hover:text-red-500 transition-colors">→</span>
                          </div>
                          <p class="text-slate-400 text-sm leading-relaxed mt-4 line-clamp-3 text-justify">{activity.summary}</p>
                          <div class="flex flex-wrap gap-3 mt-5 text-[10px] text-slate-500 uppercase tracking-widest font-bold"><span>{activity.role}</span>{activity.location && <span>• {activity.location}</span>}<span>• {activity.eventDate}</span></div>
                        </div>
                      </a>;
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div class="py-20 text-center bg-white/5 border border-dashed border-white/10 rounded-3xl"><p class="text-slate-500 font-bold">Belum ada kegiatan yang cocok dengan filter ini.</p></div>
          )}
        </section>

        {milestones.length > 0 && (
          <section class="max-w-5xl mx-auto mt-24 pt-12 border-t border-white/10">
            <h2 class="text-2xl md:text-3xl font-black italic mb-8">CAREER <span class="text-cyan-400">MILESTONES</span></h2>
            <div class="grid md:grid-cols-3 gap-4">
              {milestones.slice(0, 6).map(item => <div class="bg-white/5 border border-white/10 rounded-2xl p-5"><p class="text-xs font-black text-cyan-400">{item.year}</p><h3 class="font-bold mt-2">{item.title}</h3><p class="text-sm text-slate-500 mt-2">{item.description}</p></div>)}
            </div>
          </section>
        )}
      </div>
    </Layout>
  );
});

app.get('/jejak/:slug', async (c) => {
  const user = c.var.user;
  const results = await db.select().from(activityTable).where(and(eq(activityTable.slug, c.req.param('slug')), eq(activityTable.status, 'published'))).limit(1);
  const activity = results[0];
  if (!activity) return c.notFound();
  const media = await db.select().from(activityMediaTable).where(eq(activityMediaTable.activityId, activity.id)).orderBy(activityMediaTable.sortOrder);
  const activityLinks = await db.select().from(activityLinkTable).where(eq(activityLinkTable.activityId, activity.id)).orderBy(activityLinkTable.sortOrder);
  const additionalLinks = activityLinks.filter(link => link.label && link.url);
  const scheduledLinks: ScheduledActivityLink[] = [
    activity.materialUrl ? { label: 'Lihat Materi', url: activity.materialUrl, availableFrom: activity.materialAvailableFrom, availableUntil: activity.materialAvailableUntil } : null,
    activity.certificateUrl ? { label: 'Sertifikat', url: activity.certificateUrl, availableFrom: activity.certificateAvailableFrom, availableUntil: activity.certificateAvailableUntil } : null,
    activity.publicationUrl ? { label: 'Publikasi', url: activity.publicationUrl, availableFrom: activity.publicationAvailableFrom, availableUntil: activity.publicationAvailableUntil } : null,
    ...additionalLinks.map(link => ({ label: link.label, url: link.url, availableFrom: link.availableFrom, availableUntil: link.availableUntil, accent: true })),
  ].filter(Boolean) as ScheduledActivityLink[];
  const participantWorks = await db.select().from(participantWorkTable).where(and(eq(participantWorkTable.activityId, activity.id), eq(participantWorkTable.status, 'published'), eq(participantWorkTable.consent, true))).orderBy(participantWorkTable.sortOrder);
  const publishedWorks = participantWorks.filter(work => work.title && work.participantName);
  const testimonials = await db.select().from(testimonialTable).where(and(eq(testimonialTable.activityId, activity.id), eq(testimonialTable.status, 'published'), eq(testimonialTable.consent, true))).orderBy(desc(testimonialTable.createdAt)).limit(6);
  const reactionCounts = await getParticipantWorkReactionCounts();
  const descriptionHtml = activity.description ? await marked.parse(activity.description) : '';

  return c.html(
    <Layout title={`${activity.title} | Jejak Ferilee`} user={user} needsProfiling={c.var.needsProfiling} currentPath="/jejak" ogImage={activity.coverImage || `/api/og?title=${encodeURIComponent(activity.title)}&category=${encodeURIComponent(activity.category)}`}>
      <article class="max-w-5xl mx-auto px-6 py-28 md:py-32">
        <a href="/jejak" class="text-xs font-black text-red-500 uppercase tracking-widest hover:text-white transition-colors">← Kembali ke Jejak</a>
        <header class="mt-8 grid lg:grid-cols-[1.1fr_0.9fr] gap-10 items-center">
          <div><p class="text-xs font-black text-red-500 uppercase tracking-[0.3em]">{activity.category} • {activity.role}</p><h1 class="text-4xl md:text-6xl font-black tracking-tight mt-4 leading-tight">{activity.title}</h1><p class="text-slate-400 text-lg mt-6 leading-relaxed">{activity.summary}</p><div class="flex flex-wrap gap-3 mt-8 text-xs text-slate-400"><span class="px-3 py-2 rounded-lg bg-white/5 border border-white/10">{activity.eventDate}{activity.endDate ? ` — ${activity.endDate}` : ''}</span>{activity.location && <span class="px-3 py-2 rounded-lg bg-white/5 border border-white/10">{activity.location}</span>}{activity.organizer && <span class="px-3 py-2 rounded-lg bg-white/5 border border-white/10">{activity.organizer}</span>}</div></div>
          {activity.coverImage ? <img src={activity.coverImage} alt={activity.title} class="w-full max-h-[420px] object-cover rounded-[2rem] border border-white/10 shadow-2xl" /> : <div class="w-full h-72 rounded-[2rem] bg-gradient-to-br from-red-950 to-slate-950 border border-white/10"></div>}
        </header>

        <div class="grid lg:grid-cols-[1fr_280px] gap-12 mt-16">
          <div>
            <div class="prose prose-invert prose-red prose-p:text-justify max-w-none text-slate-300 leading-relaxed" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
          </div>
          <aside><p class="mb-4 text-xs font-black uppercase tracking-widest text-slate-500">Tautan</p><div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">{scheduledLinks.map(link => renderScheduledActivityLink(link))}<div class="relative sm:col-span-2 lg:col-span-1" data-share-root><button type="button" data-share-button data-share-title={activity.title} onclick="shareActivity(this)" aria-expanded="false" aria-haspopup="menu" class="w-full min-h-12 rounded-xl bg-red-700 px-4 py-3 text-left text-sm font-bold transition-colors hover:bg-red-800">Bagikan kegiatan</button><div data-share-menu role="menu" class="hidden absolute right-0 top-full z-20 mt-2 w-full min-w-56 overflow-hidden rounded-2xl border border-white/10 bg-slate-950 p-2 shadow-2xl"><a data-share-link="whatsapp" role="menuitem" target="_blank" rel="noreferrer" class="block rounded-xl px-4 py-3 text-sm font-bold text-slate-300 transition-colors hover:bg-green-500/15 hover:text-green-300">WhatsApp</a><a data-share-link="telegram" role="menuitem" target="_blank" rel="noreferrer" class="block rounded-xl px-4 py-3 text-sm font-bold text-slate-300 transition-colors hover:bg-sky-500/15 hover:text-sky-300">Telegram</a><a data-share-link="facebook" role="menuitem" target="_blank" rel="noreferrer" class="block rounded-xl px-4 py-3 text-sm font-bold text-slate-300 transition-colors hover:bg-blue-500/15 hover:text-blue-300">Facebook</a><a data-share-link="x" role="menuitem" target="_blank" rel="noreferrer" class="block rounded-xl px-4 py-3 text-sm font-bold text-slate-300 transition-colors hover:bg-white/10 hover:text-white">X</a><a data-share-link="linkedin" role="menuitem" target="_blank" rel="noreferrer" class="block rounded-xl px-4 py-3 text-sm font-bold text-slate-300 transition-colors hover:bg-cyan-500/15 hover:text-cyan-300">LinkedIn</a><button type="button" role="menuitem" onclick="copyActivityLink(this)" class="block w-full rounded-xl px-4 py-3 text-left text-sm font-bold text-slate-400 transition-colors hover:bg-white/10 hover:text-white">Salin tautan</button></div></div></div></aside>
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
          (() => {
            const formatRemaining = (milliseconds) => {
              const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60000));
              const days = Math.floor(totalMinutes / (60 * 24));
              const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
              const minutes = totalMinutes % 60;
              if (days > 0) return days + ' hari ' + hours + ' jam';
              if (hours > 0) return hours + ' jam ' + minutes + ' menit';
              return minutes + ' menit';
            };
            const updateCountdowns = () => {
              document.querySelectorAll('[data-link-countdown]').forEach((element) => {
                const start = Number(element.getAttribute('data-start'));
                const remaining = start - Date.now();
                if (!Number.isFinite(start) || remaining <= 0) {
                  window.location.reload();
                  return;
                }
                element.textContent = formatRemaining(remaining) + ' lagi';
              });
            };
            updateCountdowns();
            window.setInterval(updateCountdowns, 60000);
          })();

          (() => {
            const root = document.querySelector('[data-share-root]');
            const menu = root?.querySelector('[data-share-menu]');
            const shareButton = root?.querySelector('[data-share-button]');

            const getShareData = () => ({
              title: shareButton?.dataset.shareTitle || document.title,
              url: window.location.href,
            });

            const closeShareMenu = () => {
              menu?.classList.add('hidden');
              shareButton?.setAttribute('aria-expanded', 'false');
            };

            const prepareShareLinks = () => {
              const { title, url } = getShareData();
              const encodedTitle = encodeURIComponent(title);
              const encodedUrl = encodeURIComponent(url);
              const encodedMessage = encodeURIComponent(title + ' — ' + url);
              const links = {
                whatsapp: 'https://wa.me/?text=' + encodedMessage,
                telegram: 'https://t.me/share/url?url=' + encodedUrl + '&text=' + encodedTitle,
                facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + encodedUrl,
                x: 'https://twitter.com/intent/tweet?text=' + encodedTitle + '&url=' + encodedUrl,
                linkedin: 'https://www.linkedin.com/sharing/share-offsite/?url=' + encodedUrl,
              };

              Object.entries(links).forEach(([platform, href]) => {
                const link = root?.querySelector('[data-share-link="' + platform + '"]');
                if (link) link.href = href;
              });
            };

            window.shareActivity = async (button) => {
              const { title, url } = getShareData();
              if (navigator.share) {
                try {
                  await navigator.share({ title, text: title, url });
                  return;
                } catch (error) {
                  if (error?.name === 'AbortError') return;
                }
              }

              prepareShareLinks();
              const isOpening = menu?.classList.contains('hidden');
              menu?.classList.toggle('hidden', !isOpening);
              button?.setAttribute('aria-expanded', String(isOpening));
            };

            window.copyActivityLink = async (button) => {
              const { url } = getShareData();
              try {
                if (navigator.clipboard?.writeText) {
                  await navigator.clipboard.writeText(url);
                } else {
                  const input = document.createElement('textarea');
                  input.value = url;
                  input.setAttribute('readonly', '');
                  input.style.position = 'fixed';
                  input.style.opacity = '0';
                  document.body.appendChild(input);
                  input.select();
                  document.execCommand('copy');
                  input.remove();
                }
                button.textContent = 'Tautan tersalin';
                setTimeout(() => { button.textContent = 'Salin tautan'; }, 1800);
                closeShareMenu();
              } catch (error) {
                window.prompt('Salin tautan kegiatan:', url);
              }
            };

            document.addEventListener('click', (event) => {
              if (root && !root.contains(event.target)) closeShareMenu();
            });
            document.addEventListener('keydown', (event) => {
              if (event.key === 'Escape') closeShareMenu();
            });
          })();
        `}} />

        {(media.length > 0 || activity.galleryAlbumUrl) && <section class="mt-20"><div class="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><h2 class="text-2xl md:text-3xl font-black italic">DOKUMENTASI <span class="text-red-700">KEGIATAN</span></h2>{activity.galleryAlbumUrl && <a href={activity.galleryAlbumUrl} target="_blank" rel="noreferrer" class="shrink-0 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs font-black uppercase tracking-widest text-red-300 transition-all hover:bg-red-500/20">Lihat Album Lengkap ↗</a>}</div>{media.length > 0 && <div class="grid sm:grid-cols-2 md:grid-cols-3 gap-5">{media.map(item => <figure class="group"><div class="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/10 group-hover:border-red-500/40 transition-all"><img src={item.url} alt={item.caption || activity.title} class="h-full w-full object-cover transition-transform group-hover:scale-105" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden'); this.nextElementSibling.classList.add('flex')" /><div class="absolute inset-0 hidden items-center justify-center bg-slate-950/80 px-4 text-center text-xs font-bold text-slate-500">Gambar tidak tersedia</div></div>{item.caption && <figcaption class="text-xs text-slate-500 mt-2">{item.caption}</figcaption>}</figure>)}</div>}</section>}

        <section id="karya-peserta" class="mt-20 border-t border-white/10 pt-12"><div class="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p class="text-xs font-black uppercase tracking-[0.3em] text-cyan-400">Ruang Karya Peserta</p><h2 class="mt-2 text-2xl font-black italic md:text-3xl">KARYA <span class="text-cyan-400">PESERTA</span></h2><p class="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Hasil eksplorasi dan praktik peserta dalam kegiatan ini.</p></div><a href={'/jejak/' + activity.slug + '/kirim-karya'} class="shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-xs font-black uppercase tracking-widest text-cyan-300 transition-all hover:bg-cyan-500/20 hover:text-white">Kirim Karya ↗</a></div>{publishedWorks.length > 0 ? <div class="grid gap-5 md:grid-cols-2">{publishedWorks.map(work => renderParticipantWorkCard(work, null, reactionCounts.get(work.id) || 0))}</div> : <div class="rounded-2xl border border-dashed border-white/10 bg-white/5 p-8 text-center"><p class="text-sm text-slate-500">Belum ada karya peserta yang dipublikasikan.</p><p class="mt-2 text-xs text-slate-600">Jika Anda mengikuti kegiatan ini, Anda dapat mengirimkan karya untuk ditinjau.</p></div>}</section>
        <section id="testimoni" class="mt-20 border-t border-white/10 pt-12"><div class="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p class="text-xs font-black uppercase tracking-[0.3em] text-cyan-400">Pengalaman Peserta</p><h2 class="mt-2 text-2xl font-black italic md:text-3xl">TESTIMONI <span class="text-cyan-400">PESERTA</span></h2><p class="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">Cerita singkat dari peserta yang mengikuti kegiatan ini.</p></div><a href={`/jejak/${activity.slug}/testimoni`} class="shrink-0 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-xs font-black uppercase tracking-widest text-cyan-300 transition-all hover:bg-cyan-500/20 hover:text-white">Bagikan Pengalaman ↗</a></div>{testimonials.length > 0 ? <div class="grid gap-5 md:grid-cols-2 lg:grid-cols-3">{testimonials.map(testimonial => renderTestimonialCard(testimonial))}</div> : <div class="rounded-2xl border border-dashed border-white/10 bg-white/5 p-8 text-center"><p class="text-sm text-slate-500">Belum ada testimoni yang dipublikasikan.</p><p class="mt-2 text-xs text-slate-600">Anda dapat menjadi peserta pertama yang membagikan pengalaman.</p></div>}</section>
        {renderParticipantWorkReactionScript()}
      </article>
    </Layout>
  );
});

app.get('/blog/:slug', async (c) => {
  const user = c.var.user;
  try {
    const slug = c.req.param('slug');
    const results = await db.select().from(blogPosts).where(eq(blogPosts.slug, slug)).limit(1);
    const post = results[0];
    if (!post) return c.notFound();
    
    const contentHtml = await marked.parse(post.content || '');
    const ogImage = post.coverImage || `/api/og?title=${encodeURIComponent(post.title)}&category=${encodeURIComponent(post.category || 'Blog')}`;
    
    // Reading Time Calculation
    const words = post.content?.split(/\s+/).length || 0;
    const readingTime = Math.ceil(words / 200);

    const reactions = await db.select().from(reactionTable).where(eq(reactionTable.postId, post.id));
    const allComments = await db.select().from(commentTable).where(eq(commentTable.postId, post.id)).orderBy(desc(commentTable.createdAt));
    
    // Organize comments into threads
    const mainComments = allComments.filter(c => !c.parentId);
    const replies = allComments.filter(c => c.parentId);

    const reactionCounts = {
      like: reactions.filter(r => r.type === 'like').length,
      love: reactions.filter(r => r.type === 'love').length,
      fire: reactions.filter(r => r.type === 'fire').length,
      rocket: reactions.filter(r => r.type === 'rocket').length,
    };

    const userReaction = user ? reactions.find(r => r.userEmail === user.email)?.type : null;
    const baseUrl = process.env.BASE_URL || 'http://localhost:4128';
    const postUrl = `${baseUrl}/blog/${post.slug}`;

    return c.html(
      <Layout title={`${post.title} | Ferilee`} user={user} ogImage={ogImage} needsProfiling={c.var.needsProfiling} currentPath="/blog">
        {/* Progress Bar */}
        <div id="progress-bar" class="fixed top-0 left-0 h-1 bg-cyan-500 z-[100] transition-all duration-150" style="width: 0%"></div>
        <script dangerouslySetInnerHTML={{ __html: `
          window.onscroll = function() {
            const winScroll = document.body.scrollTop || document.documentElement.scrollTop;
            const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
            const scrolled = (winScroll / height) * 100;
            document.getElementById("progress-bar").style.width = scrolled + "%";
          };
        `}} />

        <article class="max-w-3xl mx-auto px-4 md:px-6 py-10 md:py-20">
          <header class="mb-12">
            <div class="flex flex-wrap gap-4 items-center mb-6">
              <span class="text-xs font-bold text-cyan-400 uppercase tracking-widest">{post.category}</span>
              <span class="text-xs text-slate-500">{new Date(post.createdAt!).toLocaleDateString()}</span>
              <span class="text-xs text-slate-500 flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                {readingTime} menit baca
              </span>
              <span class="text-xs text-slate-500 flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-10.6 8.38 8.38 0 0 1 3.8.9L21 4.5l-1.5 6.5z"/></svg>
                {allComments.length} Komentar
              </span>
            </div>
            <h1 class="text-3xl md:text-5xl font-black mb-8 leading-tight break-words">{post.title}</h1>
            {post.coverImage && (
              <div class="mt-8 rounded-[2rem] overflow-hidden border border-white/10 bg-white/5 shadow-2xl">
                <img src={post.coverImage} alt={post.title} class="w-full max-h-[60vh] object-cover" />
              </div>
            )}
          </header>
          
          <div class="prose prose-invert prose-cyan prose-p:text-justify max-w-none text-slate-300 leading-relaxed text-lg mb-16" dangerouslySetInnerHTML={{ __html: contentHtml }} />
          
          {/* Interactive Section: Reactions & Share */}
          <div class="mt-16 pt-8 space-y-8">
            {/* Reactions Section */}
            <div class="flex flex-wrap items-center gap-4">
              <span class="text-xs font-black text-slate-500 uppercase tracking-widest mr-2">Reaksi</span>
              <div class="flex items-center gap-2">
                {[
                  { type: 'like', emoji: '👍' },
                  { type: 'love', emoji: '❤️' },
                  { type: 'fire', emoji: '🔥' },
                  { type: 'rocket', emoji: '🚀' }
                ].map(item => (
                  <form action={`/blog/${post.id}/react`} method="post">
                    <input type="hidden" name="type" value={item.type} />
                    <button 
                      type="submit" 
                      class={`flex items-center gap-2 px-4 py-2 rounded-full border transition-all ${userReaction === item.type ? 'bg-red-500/20 border-red-500/50 text-red-500' : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'} ${!user ? 'opacity-50 cursor-not-allowed' : 'hover:scale-110 active:scale-95'}`}
                      disabled={!user}
                      title={!user ? "Masuk untuk memberi reaksi" : ""}
                    >
                      <span>{item.emoji}</span>
                      <span class="text-xs font-bold">{reactionCounts[item.type as keyof typeof reactionCounts] || 0}</span>
                    </button>
                  </form>
                ))}
              </div>
              {!user && <p class="text-[10px] font-bold text-slate-600 uppercase tracking-widest italic ml-auto">Masuk untuk memberi reaksi</p>}
            </div>

            {/* Social Share Section */}
            <div class="flex items-center gap-4 pt-4">
              <span class="text-xs font-black text-slate-500 uppercase tracking-widest mr-2">Bagikan tulisan</span>
              <div class="flex gap-2">
                {/* X (Twitter) */}
                <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(post.title)}&url=${encodeURIComponent(postUrl)}`} target="_blank" class="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 hover:border-white/30 transition-all text-slate-400 hover:text-white" title="Share on X">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"/></svg>
                </a>
                {/* Facebook */}
                <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(postUrl)}`} target="_blank" class="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-blue-600/20 hover:border-blue-600/50 transition-all text-slate-400 hover:text-blue-500" title="Share on Facebook">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>
                </a>
                {/* Instagram (Copy Link fallback) */}
                <button onclick={`navigator.clipboard.writeText(${JSON.stringify(postUrl)}); alert('Tautan disalin untuk Instagram!')`} class="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-pink-600/20 hover:border-pink-600/50 transition-all text-slate-400 hover:text-pink-500" title="Salin tautan untuk Instagram">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="20" x="2" y="2" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
                </button>
                {/* WhatsApp */}
                <a href={`https://wa.me/?text=${encodeURIComponent(post.title + ' ' + postUrl)}`} target="_blank" class="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-green-600/20 hover:border-green-600/50 transition-all text-slate-400 hover:text-green-500" title="Share on WhatsApp">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 1 1-7.6-10.6 8.38 8.38 0 0 1 3.8.9L21 4.5l-1.5 6.5z"/></svg>
                </a>
                {/* Telegram */}
                <a href={`https://t.me/share/url?url=${encodeURIComponent(postUrl)}&text=${encodeURIComponent(post.title)}`} target="_blank" class="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-sky-500/20 hover:border-sky-500/50 transition-all text-slate-400 hover:text-sky-400" title="Share on Telegram">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
                </a>
              </div>
            </div>
          </div>

          <div class="mt-16 md:mt-32 border-t border-white/10 pt-10 md:pt-16">
            <h3 class="text-2xl font-black italic mb-8 tracking-tight">BAGIAN <span class="text-red-500">KOMENTAR</span> ({allComments.length})</h3>
            
            {/* Comment Form */}
            {user ? (
              <div id="comment-form-container" class="bg-white/5 border border-white/10 p-6 md:p-8 rounded-[2rem] backdrop-blur-xl mb-16 transition-all">
                <div class="flex justify-between items-center mb-6">
                  <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-full border border-white/10 overflow-hidden">
                      {user.picture ? <img src={user.picture} class="w-full h-full object-cover" /> : <div class="w-full h-full bg-red-900/20 flex items-center justify-center text-red-500 font-bold">{user.name[0]}</div>}
                    </div>
                    <div>
                      <p class="text-sm font-bold">{user.name}</p>
                      <p class="text-[10px] text-slate-500 uppercase font-black tracking-widest">{user.role}</p>
                    </div>
                  </div>
                  <div id="replying-to" class="hidden text-xs font-bold text-cyan-400 flex items-center gap-2">
                    <span>Membalas <span id="reply-name"></span></span>
                    <button onclick="cancelReply()" class="text-slate-500 hover:text-white underline">Batal</button>
                  </div>
                </div>
                <form action={`/blog/${post.id}/comment`} method="post" class="space-y-6">
                  <input type="hidden" name="parentId" id="parent-id-input" value="" />
                  <textarea name="content" id="comment-textarea" required class="w-full bg-slate-950/50 border border-white/10 rounded-2xl p-6 text-slate-300 focus:outline-none focus:border-red-500 transition-all mb-4 min-h-[120px]" placeholder="Tulis pendapat Anda..."></textarea>
                  <button type="submit" class="px-8 py-3 bg-red-700 hover:bg-red-800 text-white font-bold rounded-xl transition-all hover:scale-105 active:scale-95">Kirim Komentar</button>
                </form>
              </div>
            ) : (
              <div class="text-center py-12 bg-white/5 border border-dashed border-white/10 rounded-[2rem] mb-16">
                <p class="text-slate-400 mb-6">Ingin ikut berdiskusi?</p>
                <a href="/admin/login" class="px-10 py-4 bg-white text-black font-black rounded-xl hover:bg-slate-200 transition-all tracking-widest uppercase text-sm">Masuk untuk Berkomentar</a>
              </div>
            )}

            <script dangerouslySetInnerHTML={{ __html: `
              function setReply(id, name) {
                document.getElementById('parent-id-input').value = id;
                document.getElementById('reply-name').innerText = name;
                document.getElementById('replying-to').classList.remove('hidden');
                document.getElementById('comment-form-container').scrollIntoView({ behavior: 'smooth' });
                document.getElementById('comment-textarea').focus();
              }
              function cancelReply() {
                document.getElementById('parent-id-input').value = '';
                document.getElementById('replying-to').classList.add('hidden');
              }
            `}} />

            {/* Comments List */}
            <div class="space-y-8">
              {mainComments.map(comment => (
                <div class="space-y-4">
                  <div class="bg-white/5 border border-white/5 p-6 rounded-2xl">
                    <div class="flex justify-between items-start mb-4">
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full overflow-hidden bg-red-900/20 flex items-center justify-center text-red-500 text-xs font-bold">
                          {comment.picture ? <img src={comment.picture} class="w-full h-full object-cover" /> : comment.name[0]}
                        </div>
                        <div>
                          <p class="text-sm font-bold">{comment.name}</p>
                          <p class="text-[10px] text-slate-500">{new Date(comment.createdAt!).toLocaleString()}</p>
                        </div>
                      </div>
                      {user && (
                        <button onclick={`setReply(${comment.id}, ${JSON.stringify(comment.name)})`} class="text-[10px] font-black text-cyan-400 uppercase tracking-widest hover:text-white transition-all">Balas</button>
                      )}
                    </div>
                    <p class="text-slate-400 text-sm leading-relaxed">{comment.content}</p>
                  </div>
                  
                  {/* Replies */}
                  <div class="ml-4 md:ml-8 space-y-4 border-l-2 border-white/5 pl-4 md:pl-8">
                    {replies.filter(r => r.parentId === comment.id).map(reply => (
                      <div class="bg-white/5 border border-white/5 p-6 rounded-2xl">
                        <div class="flex justify-between items-start mb-4">
                          <div class="flex items-center gap-3">
                            <div class="w-8 h-8 rounded-full overflow-hidden bg-cyan-900/20 flex items-center justify-center text-cyan-400 text-xs font-bold">
                              {reply.picture ? <img src={reply.picture} class="w-full h-full object-cover" /> : reply.name[0]}
                            </div>
                            <div>
                              <p class="text-sm font-bold">{reply.name}</p>
                              <p class="text-[10px] text-slate-500">{new Date(reply.createdAt!).toLocaleString()}</p>
                            </div>
                          </div>
                        </div>
                        <p class="text-slate-400 text-sm leading-relaxed">{reply.content}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {allComments.length === 0 && <p class="text-center text-slate-600 font-bold italic py-8">Jadilah yang pertama berkomentar!</p>}
            </div>
          </div>
        </article>
      </Layout>
    );
  } catch (err: any) {
    return c.text(`Internal Server Error: ${err.message}`, 500);
  }
});

app.post('/blog/:id/comment', async (c) => {
  const user = c.var.user;
  if (!user) return c.redirect('back');

  const postId = parseInt(c.req.param('id'));
  const body = await c.req.parseBody();
  const content = body.content as string;
  const parentId = body.parentId ? parseInt(body.parentId as string) : null;

  if (!content) return c.redirect('back');

  await db.insert(commentTable).values({
    postId,
    parentId,
    name: user.name,
    email: user.email,
    picture: user.picture,
    content,
  });
  await createAdminNotification({
    type: 'comment',
    title: 'Komentar baru',
    message: `${user.name} menambahkan komentar pada blog.`,
    href: '/admin/inbox#comments',
  });

  const post = await db.select().from(blogPosts).where(eq(blogPosts.id, postId)).limit(1);
  return c.redirect(`/blog/${post[0].slug}`);
});

app.post('/blog/:id/react', async (c) => {
  const user = c.var.user;
  if (!user) return c.redirect('back');

  const postId = parseInt(c.req.param('id'));
  const body = await c.req.parseBody();
  const type = body.type as string;

  // Check if user already reacted with this type
  const existing = await db.select().from(reactionTable).where(and(
    eq(reactionTable.postId, postId),
    eq(reactionTable.userEmail, user.email),
    eq(reactionTable.type, type)
  )).limit(1);

  if (existing.length > 0) {
    // Remove reaction if already exists (toggle)
    await db.delete(reactionTable).where(eq(reactionTable.id, existing[0].id));
  } else {
    // Remove any existing reaction from this user for this post to only allow one type
    await db.delete(reactionTable).where(and(
      eq(reactionTable.postId, postId),
      eq(reactionTable.userEmail, user.email)
    ));
    // Add new reaction
    await db.insert(reactionTable).values({
      postId,
      userEmail: user.email,
      type,
    });
  }

  const post = await db.select().from(blogPosts).where(eq(blogPosts.id, postId)).limit(1);
  return c.redirect(`/blog/${post[0].slug}`);
});

app.post('/subscribe', async (c) => {
  try {
    const body = await c.req.parseBody();
    const email = body.email as string;
    if (!email) return c.redirect('back');

    await db.insert(subTable).values({ email }).onConflictDoNothing();
    return c.redirect('/blog?subscribed=1');
  } catch (err) {
    return c.redirect('/blog?error=1');
  }
});

app.get('/contact', (c) => {
  const user = c.var.user;
  const inputClass = "peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent";
  const labelClass = "absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-slate-500 peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-placeholder-shown:lowercase peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500 peer-focus:uppercase peer-focus:font-bold peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:text-red-500 peer-[:not(:placeholder-shown)]:uppercase peer-[:not(:placeholder-shown)]:font-bold";
  const success = c.req.query('success');

  return c.html(
    <Layout title="Kontak | Ferilee" user={user}>
      <div class="max-w-4xl mx-auto px-6 py-20">

        <div class="text-center mb-16">
          <h1 class="text-5xl font-black mb-4 tracking-tight">Mari <span class="text-red-700">Terhubung</span></h1>
          <p class="text-slate-400 text-lg">Punya proyek dalam pikiran atau sekadar ingin menyapa?</p>
        </div>

        <div class="bg-white/5 border border-white/10 p-8 md:p-12 rounded-[3rem] backdrop-blur-xl relative overflow-hidden">
          <div class="absolute -top-24 -right-24 w-64 h-64 bg-red-900/10 rounded-full blur-[100px]"></div>
          
          {success ? (
            <div class="relative z-10 text-center py-10">
              <div class="w-48 h-48 mx-auto mb-4">
                <dotlottie-player 
                  src="https://lottie.host/6ad8993d-3312-4467-8848-3561916361a4/4f50lqFvL5.json" 
                  background="transparent" 
                  speed="1.2" 
                  style="width: 100%; height: 100%;" 
                  autoplay
                ></dotlottie-player>
              </div>
              <h2 class="text-3xl font-black mb-4 tracking-tight">PESAN TERKIRIM!</h2>
              <p class="text-slate-400 mb-10">Terima kasih sudah menghubungi saya. Saya akan membalas sesegera mungkin.</p>
              <a href="/" class="px-10 py-4 border border-white/10 rounded-xl font-bold hover:bg-white/5 transition-all">Kembali ke Beranda</a>
            </div>
          ) : (
            <form action="/contact/send" method="post" class="space-y-8 relative z-10">
              <div class="grid md:grid-cols-2 gap-6">
                <div class="relative">
                  <input type="text" name="name" id="name" placeholder=" " required class={inputClass} value={user?.name || ''} />
                  <label for="name" class={labelClass}>Nama Anda</label>
                </div>
                <div class="relative">
                  <input type="email" name="email" id="email" placeholder=" " required class={inputClass} value={user?.email || ''} />
                  <label for="email" class={labelClass}>Alamat Email</label>
                </div>
              </div>

              
              <div class="relative">
                <input type="text" name="subject" id="subject" placeholder=" " required class={inputClass} />
                <label for="subject" class={labelClass}>Subjek</label>
              </div>

              <div class="relative">
                <textarea name="message" id="message" rows={5} placeholder=" " required class={`${inputClass} leading-relaxed min-h-[150px]`}></textarea>
                <label for="message" class={labelClass}>Pesan Anda</label>
              </div>

              <button type="submit" class="w-full py-5 bg-red-700 hover:bg-red-800 text-white font-black rounded-2xl transition-all hover:scale-[1.02] active:scale-[0.98] btn-shadow tracking-widest uppercase">Kirim Pesan</button>
            </form>
          )}
        </div>
      </div>
    </Layout>
  );
});

app.post('/contact/send', async (c) => {
  try {
    const body = await c.req.parseBody();
    await db.insert(contactTable).values({
      name: body.name as string,
      email: body.email as string,
      subject: body.subject as string,
      message: body.message as string,
      isRead: 0,
    });
    await createAdminNotification({
      type: 'contact',
      title: 'Pesan kontak baru',
      message: `${body.name as string} mengirim pesan melalui halaman kontak.`,
      href: '/admin/inbox#messages',
    });
    return c.redirect('/contact?success=1');
  } catch (err: any) {
    console.error('Contact submission error:', err);
    return c.html(
      <Layout title="Kesalahan | Ferilee">
        <div class="max-w-4xl mx-auto px-6 py-20 text-center">
          <h1 class="text-3xl font-black mb-4">Ups! Terjadi kesalahan.</h1>
          <p class="text-slate-400 mb-8">Pesan belum dapat dikirim. Silakan coba lagi nanti.</p>
          <a href="/contact" class="px-10 py-4 bg-red-700 text-white font-bold rounded-xl">Kembali ke Kontak</a>
        </div>
      </Layout>,
      500
    );
  }
});

// --- ADMIN PAGES ---

app.get('/admin/login', (c) => {
  const user = c.var.user;
  if (user?.role === 'admin') return c.redirect('/admin');
  
  return c.html(
    <AdminLayout title="Admin Login | Ferilee" user={user} currentPath="/admin/login" showNavigation={false}>
      <div class="max-w-md mx-auto px-6 py-20">

        <div class="bg-white/5 border border-white/10 p-8 rounded-[2rem] backdrop-blur-xl relative overflow-hidden">
          <h1 class="text-3xl font-black mb-8 text-center tracking-tight">Admin <span class="text-red-700 italic">Access</span></h1>
          <form action="/admin/login" method="post" class="space-y-8 relative z-10">
            <div class="relative">
              <input type="text" name="username" id="username" placeholder=" " class="peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent" />
              <label for="username" class="absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500">Username</label>
            </div>
            <div class="relative">
              <input type="password" name="password" id="password" placeholder=" " class="peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent" />
              <label for="password" class="absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500">Password</label>
            </div>
            <button type="submit" class="w-full py-4 bg-red-700 hover:bg-red-800 text-white font-black rounded-xl transition-all btn-shadow tracking-widest">AUTHENTICATE</button>
          </form>
          
          <div class="mt-8 relative">
            <div class="absolute inset-0 flex items-center" aria-hidden="true">
              <div class="w-full border-t border-white/10"></div>
            </div>
            <div class="relative flex justify-center text-xs uppercase font-bold tracking-widest">
              <span class="bg-slate-900 px-4 text-slate-500">OR</span>
            </div>
          </div>

          <div class="mt-8">
            <a href="/auth/google" class="flex items-center justify-center gap-3 w-full py-4 bg-white text-black font-black rounded-xl transition-all hover:bg-slate-200 active:scale-[0.98] tracking-widest">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 48 48">
                <path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12s5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24s8.955,20,20,20s20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"></path>
                <path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"></path>
                <path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"></path>
                <path fill="#1976D2" d="M43.611,20.083L43.611,20.083L42,20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"></path>
              </svg>
              LOGIN WITH GOOGLE
            </a>
          </div>
          {c.req.query('error') && <p class="mt-6 text-center text-red-500 text-xs font-bold uppercase tracking-widest">Invalid credentials</p>}
        </div>
      </div>
      </AdminLayout>
  );
});

app.post('/admin/login', async (c) => {
  const body = await c.req.parseBody();
  if (body.username === process.env.ADMIN_USERNAME && body.password === process.env.ADMIN_PASSWORD) {
    const sessionUser: SessionUser = {
      email: 'the.real.ferilee@gmail.com',
      name: 'Ferilee Admin',
      role: 'admin'
    };
    setCookie(c, 'user_session', encodeURIComponent(JSON.stringify(sessionUser)), { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 3600 * 24 });
    return c.redirect('/admin');
  }
  return c.redirect('/admin/login?error=1');
});


// --- GOOGLE OAUTH ROUTES ---

app.get('/auth/google', (c) => {
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: process.env.REDIRECT_URI || '',
    client_id: process.env.GOOGLE_CLIENT_ID || '',
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email',
    ].join(' '),
  };

  const qs = new URLSearchParams(options);
  return c.redirect(`${rootUrl}?${qs.toString()}`);
});

app.get('/auth/google/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.redirect('/admin/login?error=no_code');

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const googleUser = await userResponse.json();

    if (googleUser.picture) {
      try {
        await db.update(commentTable)
          .set({ picture: googleUser.picture })
          .where(eq(commentTable.email, googleUser.email));
      } catch (err) {
        console.error('Failed to retroactively update comment pictures', err);
      }
    }

    const isAdmin = googleUser.email === 'the.real.ferilee@gmail.com';
    const sessionUser: SessionUser = {
      email: googleUser.email,
      name: googleUser.name,
      picture: googleUser.picture,
      role: isAdmin ? 'admin' : 'visitor',
    };

    setCookie(c, 'user_session', encodeURIComponent(JSON.stringify(sessionUser)), { 
      path: '/', 
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production', 
      maxAge: 3600 * 24 * 7 
    });

    if (isAdmin) {
      return c.redirect('/admin');
    }
    return c.redirect('/');
  } catch (error: any) {
    console.error('OAuth Error:', error);
    return c.redirect(`/admin/login?error=oauth_failed&msg=${encodeURIComponent(error.message)}`);
  }
});

app.get('/auth/logout', (c) => {
  setCookie(c, 'user_session', '', { path: '/', maxAge: 0 });
  return c.redirect('/');
});



app.get('/admin/activities', async (c) => {
  const user = c.var.user;
  const activities = await db.select().from(activityTable).orderBy(desc(activityTable.eventDate));
  const unreadCount = await getAdminNotificationCount();
  const publishedCount = activities.filter(activity => activity.status === 'published').length;
  const featuredCount = activities.filter(activity => activity.featuredOnCv).length;
  const pendingTestimonials = (await db.select().from(testimonialTable)).filter(testimonial => testimonial.status !== 'published').length;

  return c.html(
    <AdminLayout title="Jejak Activities | Admin" notificationCount={unreadCount} user={user} currentPath="/admin/activities">
      <div class="mx-auto max-w-7xl px-6 py-10 md:py-16">
        <header class="mb-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between"><div><a href="/admin" class="text-xs font-black uppercase tracking-widest text-cyan-400 hover:text-white">← Dashboard</a><h1 class="mt-5 text-4xl font-black italic tracking-tight md:text-5xl">JEJAK <span class="text-cyan-400">ACTIVITIES</span></h1><p class="mt-3 max-w-xl text-slate-500">Kelola dokumentasi kegiatan profesional, publikasi, galeri, dan highlight CV.</p></div><div class="flex flex-wrap gap-3"><a href="/admin/testimonials" class="rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-5 py-3 text-center text-xs font-black uppercase tracking-widest text-cyan-300 transition-all hover:bg-cyan-500/20 hover:text-white">Testimoni{pendingTestimonials > 0 ? ` (${pendingTestimonials})` : ''}</a><a href="/admin/activities/new" class="rounded-xl bg-cyan-700 px-5 py-3 text-center text-xs font-black uppercase tracking-widest text-white transition-all hover:bg-cyan-800">+ New Activity</a></div></header>
        <div class="mb-10 grid grid-cols-3 gap-3 md:gap-5"><div class="rounded-2xl border border-white/10 bg-white/5 p-4 md:p-6"><p class="text-2xl font-black">{activities.length}</p><p class="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Total</p></div><div class="rounded-2xl border border-white/10 bg-white/5 p-4 md:p-6"><p class="text-2xl font-black text-green-400">{publishedCount}</p><p class="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Published</p></div><div class="rounded-2xl border border-white/10 bg-white/5 p-4 md:p-6"><p class="text-2xl font-black text-cyan-400">{featuredCount}</p><p class="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">CV Featured</p></div></div>
        <section class="space-y-4">{activities.map(activity => <article class="flex flex-col gap-5 rounded-2xl border border-white/10 bg-white/5 p-5 transition-all hover:border-cyan-500/30 md:flex-row md:items-center md:justify-between md:p-6"><div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h2 class="font-black text-white">{activity.title}</h2><span class={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${activity.status === 'published' ? 'bg-green-900/30 text-green-400' : 'bg-amber-900/30 text-amber-400'}`}>{activity.status}</span>{activity.featuredOnCv && <span class="rounded-md bg-cyan-900/30 px-2 py-1 text-[9px] font-black uppercase text-cyan-400">CV</span>}</div><p class="mt-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">{activity.eventDate} • {activity.category} • {activity.role}</p><p class="mt-3 line-clamp-2 text-sm text-slate-400">{activity.summary}</p></div><div class="flex shrink-0 items-center gap-2"><a href={`/admin/works?activityId=${activity.id}`} class="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-sm font-bold text-cyan-300 hover:bg-cyan-500/10">Karya</a><a href={`/jejak/${activity.slug}`} target="_blank" rel="noreferrer" class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-400 hover:text-white">View ↗</a><a href={`/admin/activities/edit/${activity.id}`} class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-400 hover:text-white">Edit</a><form action={`/admin/activities/delete/${activity.id}`} method="post" onsubmit="return confirm('Delete this activity?')"><button type="submit" class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-500 hover:border-red-500/30 hover:text-red-400">Delete</button></form></div></article>)}{activities.length === 0 && <div class="rounded-2xl border border-dashed border-white/10 p-16 text-center text-sm font-bold text-slate-500">Belum ada kegiatan. Buat kegiatan pertama dari tombol di atas.</div>}</section>
      </div>
    </AdminLayout>
  );
});

app.get('/admin/testimonials', async (c) => {
  const user = c.var.user;
  const testimonials = await db.select().from(testimonialTable).orderBy(desc(testimonialTable.createdAt));
  const activities = await db.select({ id: activityTable.id, title: activityTable.title }).from(activityTable);
  const activitiesById = new Map(activities.map(activity => [activity.id, activity.title]));
  const unreadCount = await getAdminNotificationCount();

  return c.html(
    <AdminLayout title="Testimonials | Admin" notificationCount={unreadCount} user={user} currentPath="/admin/activities">
      <div class="mx-auto max-w-5xl px-6 py-10 md:py-16"><header class="mb-10"><a href="/admin/activities" class="text-xs font-black uppercase tracking-widest text-cyan-400 hover:text-white">← Jejak Activities</a><h1 class="mt-5 text-4xl font-black italic tracking-tight md:text-5xl">TESTIMONI <span class="text-cyan-400">PESERTA</span></h1><p class="mt-3 max-w-xl text-slate-500">Tinjau pengalaman peserta sebelum ditampilkan di website publik.</p></header><section class="space-y-4">{testimonials.map(testimonial => <article class="rounded-2xl border border-white/10 bg-white/5 p-5 md:p-6"><div class="flex flex-col gap-5 md:flex-row md:items-start md:justify-between"><div class="flex min-w-0 gap-4">{testimonial.photoUrl ? <img src={testimonial.photoUrl} alt={testimonial.participantName} class="h-12 w-12 shrink-0 rounded-xl object-cover" /> : <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-sm font-black text-red-300">{String(testimonial.participantName || '?').charAt(0).toUpperCase()}</div>}<div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h2 class="font-black text-white">{testimonial.participantName}</h2><span class={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${testimonial.status === 'published' ? 'bg-green-900/30 text-green-400' : 'bg-amber-900/30 text-amber-400'}`}>{testimonial.status === 'published' ? 'Published' : 'Pending'}</span></div><p class="mt-2 text-[10px] font-bold uppercase tracking-widest text-cyan-400">{activitiesById.get(testimonial.activityId) || 'Aktivitas tidak ditemukan'}</p>{testimonial.institution && <p class="mt-1 text-xs text-slate-500">{testimonial.institution}</p>}<p class="mt-4 text-sm leading-relaxed text-slate-300">“{testimonial.content}”</p></div></div><div class="flex shrink-0 gap-2"><form action={`/admin/testimonials/status/${testimonial.id}`} method="post"><input type="hidden" name="status" value={testimonial.status === 'published' ? 'draft' : 'published'} /><button type="submit" class={`rounded-lg border px-3 py-2 text-xs font-bold ${testimonial.status === 'published' ? 'border-amber-500/30 text-amber-300 hover:bg-amber-500/10' : 'border-green-500/30 text-green-300 hover:bg-green-500/10'}`}>{testimonial.status === 'published' ? 'Sembunyikan' : 'Publikasikan'}</button></form><form action={`/admin/testimonials/delete/${testimonial.id}`} method="post" onsubmit="return confirm('Hapus testimoni ini?')"><button type="submit" class="rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-slate-500 hover:border-red-500/30 hover:text-red-400">Hapus</button></form></div></div></article>)}{testimonials.length === 0 && <div class="rounded-2xl border border-dashed border-white/10 p-16 text-center text-sm font-bold text-slate-500">Belum ada testimoni masuk.</div>}</section></div>
    </AdminLayout>
  );
});

app.post('/admin/testimonials/status/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  const body = await c.req.parseBody();
  const status = body.status === 'published' ? 'published' : 'draft';
  await db.update(testimonialTable).set({ status, updatedAt: new Date() }).where(eq(testimonialTable.id, id));
  adminUpdates.emit('update');
  return c.redirect('/admin/testimonials');
});

app.post('/admin/testimonials/delete/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  await db.delete(testimonialTable).where(eq(testimonialTable.id, id));
  adminUpdates.emit('update');
  return c.redirect('/admin/testimonials');
});

app.get('/admin/inbox', async (c) => {
  const user = c.var.user;
  const messages = await db.select().from(contactTable).orderBy(desc(contactTable.id));
  const comments = await db.select().from(commentTable).orderBy(desc(commentTable.createdAt));
  const posts = await db.select({ id: blogPosts.id, title: blogPosts.title }).from(blogPosts);
  const unreadCount = await getAdminNotificationCount();

  const repliesByParent = new Map<number, typeof comments>();
  const rootIds = new Set(comments.filter(comment => !comment.parentId).map(comment => comment.id));
  for (const comment of comments) {
    if (comment.parentId) {
      const replies = repliesByParent.get(comment.parentId) || [];
      replies.push(comment);
      repliesByParent.set(comment.parentId, replies);
    }
  }

  const commentThreads = comments
    .filter(comment => !comment.parentId)
    .map(parent => ({ parent, replies: repliesByParent.get(parent.id) || [] }));

  // Keep a malformed/orphaned reply visible instead of losing it from moderation.
  for (const comment of comments) {
    if (comment.parentId && !rootIds.has(comment.parentId)) {
      commentThreads.push({ parent: comment, replies: [] });
    }
  }

  const commentTime = (comment: typeof comments[number]) => comment.createdAt ? new Date(comment.createdAt).getTime() : 0;
  commentThreads.sort((a, b) => {
    const aLatest = Math.max(commentTime(a.parent), ...a.replies.map(commentTime));
    const bLatest = Math.max(commentTime(b.parent), ...b.replies.map(commentTime));
    return bLatest - aLatest;
  });

  const commentsPerPage = 10;
  const requestedCommentPage = Number.parseInt(c.req.query('commentPage') || '1', 10);
  const totalCommentPages = Math.max(1, Math.ceil(commentThreads.length / commentsPerPage));
  const commentPage = Number.isFinite(requestedCommentPage)
    ? Math.min(Math.max(requestedCommentPage, 1), totalCommentPages)
    : 1;
  const visibleThreads = commentThreads.slice((commentPage - 1) * commentsPerPage, commentPage * commentsPerPage);
  const postTitles = new Map(posts.map(post => [post.id, post.title]));

  return c.html(
    <AdminLayout title="Inbox | Admin" notificationCount={unreadCount} user={user} currentPath="/admin/inbox">
      <div class="mx-auto max-w-7xl px-6 py-10 md:py-16">
        <header class="mb-10 flex flex-col gap-5 md:flex-row md:items-end md:justify-between"><div><a href="/admin" class="text-xs font-black uppercase tracking-widest text-cyan-400 hover:text-white">← Dashboard</a><h1 class="mt-5 text-4xl font-black italic tracking-tight">INBOX <span class="text-red-500">CENTER</span></h1><p class="mt-3 text-slate-500">Kelola pesan kontak dan moderasi komentar dari satu tempat.</p></div><div class="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs font-black uppercase tracking-widest text-red-300">{unreadCount} unread messages</div></header>
        <div class="mb-6 grid grid-cols-2 gap-2 md:hidden" role="tablist" aria-label="Inbox sections">
          <button type="button" data-inbox-tab="messages" class="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-3 text-xs font-black uppercase tracking-widest text-cyan-300" role="tab" aria-selected="true">Messages <span class="text-slate-400">({messages.length})</span></button>
          <button type="button" data-inbox-tab="comments" class="rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-xs font-black uppercase tracking-widest text-slate-500" role="tab" aria-selected="false">Comments <span class="text-slate-400">({comments.length})</span></button>
        </div>

        <div class="grid gap-8 lg:grid-cols-2">
          <section id="inbox-messages" class="rounded-[2rem] border border-white/10 bg-white/5 p-5 backdrop-blur-xl md:p-8">
            <div class="mb-6 flex items-center justify-between gap-4"><h2 class="text-2xl font-black italic">INBOX <span class="text-red-500">MESSAGES</span></h2><span class="rounded-full bg-white/5 px-3 py-1 text-[10px] font-black text-slate-500">{messages.length}</span></div>
            <div class="space-y-3">{messages.map(message => <article class={`rounded-2xl border ${!message.isRead ? 'border-red-500/30 ring-1 ring-red-500/20' : 'border-white/5'} bg-slate-950/40 p-4`}><div class="flex items-start justify-between gap-4"><div class="min-w-0"><p class="truncate text-[10px] font-black uppercase tracking-widest text-red-500">{message.subject}</p><h3 class="mt-1 truncate font-bold text-white">{message.name}</h3><p class="truncate text-[10px] text-slate-500">{message.email}</p></div><div class="flex shrink-0 gap-1">{!message.isRead && <form action={`/admin/contacts/read/${message.id}`} method="post"><button type="submit" class="rounded-lg p-2 text-slate-500 hover:text-green-400" title="Mark as read">✓</button></form>}<form action={`/admin/contacts/delete/${message.id}`} method="post"><button type="submit" class="rounded-lg p-2 text-slate-500 hover:text-red-400" title="Delete message">×</button></form></div></div><p class="mt-3 line-clamp-3 text-sm italic leading-relaxed text-slate-400">"{message.message}"</p><p class="mt-3 text-[9px] font-bold uppercase tracking-widest text-slate-600">{new Date(message.createdAt!).toLocaleString()}</p></article>)}{messages.length === 0 && <p class="py-12 text-center text-sm font-bold text-slate-500">Belum ada pesan.</p>}</div>
          </section>

          <section id="inbox-comments" class="hidden rounded-[2rem] border border-white/10 bg-white/5 p-5 backdrop-blur-xl md:block md:p-8">
            <div class="mb-6 flex items-start justify-between gap-4"><div><h2 class="text-2xl font-black italic">COMMENT <span class="text-red-500">MODERATION</span></h2><p class="mt-2 text-xs text-slate-500">{commentThreads.length} threads · {comments.length} comments</p></div><span class="rounded-full bg-white/5 px-3 py-1 text-[10px] font-black text-slate-500">Page {commentPage}/{totalCommentPages}</span></div>
            <div class="space-y-3">
              {visibleThreads.map(thread => {
                const threadId = `comment-thread-${thread.parent.id}`;
                const postTitle = postTitles.get(thread.parent.postId) || 'Unknown post';
                return <article class="rounded-2xl border border-white/5 bg-slate-950/40 p-4">
                  <div class="flex items-start gap-3">
                    <div class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-red-900/20 text-xs font-black text-red-400">{thread.parent.picture ? <img src={thread.parent.picture} alt="" class="h-full w-full object-cover" /> : thread.parent.name.charAt(0).toUpperCase()}</div>
                    <div class="min-w-0 flex-1"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><p class="truncate text-xs font-black uppercase tracking-widest text-slate-300">{thread.parent.name}</p><p class="truncate text-[10px] font-bold text-red-400">{thread.parent.email}</p></div><form action={`/admin/comments/delete/${thread.parent.id}`} method="post" onsubmit="return confirm('Delete this comment and its replies?')"><button type="submit" class="rounded-lg p-1 text-slate-600 hover:text-red-400" title="Delete thread">×</button></form></div><p class="mt-3 line-clamp-2 text-sm italic leading-relaxed text-slate-400">"{thread.parent.content}"</p><div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] font-black uppercase tracking-widest text-slate-600"><span>{postTitle}</span><span>•</span><span>{new Date(thread.parent.createdAt!).toLocaleString()}</span>{thread.replies.length > 0 && <span class="contents"><span>•</span><button type="button" data-thread-toggle={threadId} data-reply-count={thread.replies.length} aria-expanded="false" class="text-cyan-400 hover:text-white">{thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}</button></span>}</div></div>
                  </div>
                  {thread.replies.length > 0 && <div id={threadId} class="mt-3 hidden space-y-2 border-l-2 border-cyan-500/20 pl-4">
                    {thread.replies.map(reply => <div class="rounded-xl border border-white/5 bg-white/[0.03] p-3"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><p class="truncate text-[10px] font-black uppercase tracking-widest text-cyan-300">{reply.name}</p><p class="truncate text-[9px] text-slate-500">{reply.email}</p></div><form action={`/admin/comments/delete/${reply.id}`} method="post" onsubmit="return confirm('Delete this reply?')"><button type="submit" class="rounded-lg p-1 text-slate-600 hover:text-red-400" title="Delete reply">×</button></form></div><p class="mt-2 text-xs italic leading-relaxed text-slate-400">"{reply.content}"</p></div>)}
                  </div>}
                </article>;
              })}
              {commentThreads.length === 0 && <p class="py-12 text-center text-sm font-bold text-slate-500">Belum ada komentar.</p>}
            </div>
            {commentThreads.length > commentsPerPage && <div class="mt-6 flex items-center justify-between border-t border-white/5 pt-5"><a href={commentPage > 1 ? `/admin/inbox?commentPage=${commentPage - 1}#comments` : '#comments'} class={`rounded-xl border border-white/10 px-3 py-2 text-xs font-bold ${commentPage > 1 ? 'text-slate-300 hover:text-white' : 'pointer-events-none text-slate-700'}`}>← Previous</a><span class="text-[10px] font-black uppercase tracking-widest text-slate-600">{(commentPage - 1) * commentsPerPage + 1}-{Math.min(commentPage * commentsPerPage, commentThreads.length)} of {commentThreads.length}</span><a href={commentPage < totalCommentPages ? `/admin/inbox?commentPage=${commentPage + 1}#comments` : '#comments'} class={`rounded-xl border border-white/10 px-3 py-2 text-xs font-bold ${commentPage < totalCommentPages ? 'text-slate-300 hover:text-white' : 'pointer-events-none text-slate-700'}`}>Next →</a></div>}
          </section>
        </div>
        <script dangerouslySetInnerHTML={{ __html: `
          (() => {
            const tabs = document.querySelectorAll('[data-inbox-tab]');
            const messages = document.getElementById('inbox-messages');
            const comments = document.getElementById('inbox-comments');
            const activateTab = (name) => {
              const isComments = name === 'comments';
              if (window.innerWidth < 768) {
                messages?.classList.toggle('hidden', isComments);
                comments?.classList.toggle('hidden', !isComments);
              }
              tabs.forEach((tab) => {
                const active = tab.getAttribute('data-inbox-tab') === name;
                tab.setAttribute('aria-selected', String(active));
                tab.classList.toggle('border-cyan-400/30', active);
                tab.classList.toggle('bg-cyan-400/10', active);
                tab.classList.toggle('text-cyan-300', active);
                tab.classList.toggle('border-white/10', !active);
                tab.classList.toggle('bg-white/5', !active);
                tab.classList.toggle('text-slate-500', !active);
              });
            };
            activateTab(window.location.hash === '#comments' ? 'comments' : 'messages');
            tabs.forEach((tab) => tab.addEventListener('click', () => {
              const name = tab.getAttribute('data-inbox-tab') || 'messages';
              activateTab(name);
              history.replaceState(null, '', name === 'comments' ? '#comments' : '#messages');
            }));
            document.querySelectorAll('[data-thread-toggle]').forEach((button) => button.addEventListener('click', () => {
              const target = document.getElementById(button.getAttribute('data-thread-toggle'));
              if (!target) return;
              const hidden = target.classList.toggle('hidden');
              const count = button.getAttribute('data-reply-count') || '0';
              button.setAttribute('aria-expanded', String(!hidden));
              button.textContent = hidden ? count + (count === '1' ? ' reply' : ' replies') : 'Hide replies';
            }));
          })();
        ` }} />
      </div>
    </AdminLayout>
  );
});

app.get('/admin', async (c) => {
  const user = c.var.user;
  const posts = await db.select().from(blogPosts).orderBy(desc(blogPosts.id));
  const projects = await db.select().from(projectTable).orderBy(desc(projectTable.id));
  const activities = await db.select().from(activityTable).orderBy(desc(activityTable.eventDate));
  const messages = await db.select().from(contactTable).orderBy(desc(contactTable.id));
  const unreadCount = await getAdminNotificationCount();

  // Analytics Data
  const totalViews = await db.select({ sum: sql<number>`sum(${viewTable.count})` }).from(viewTable);
  const recentComments = await db.select().from(commentTable).where(sql`${commentTable.createdAt} > date('now', '-7 days')`);
  const totalSubs = await db.select().from(subTable);

  return c.html(
    <AdminLayout title="Admin Dashboard | Ferilee" notificationCount={unreadCount} user={user} currentPath="/admin">
      <div class="max-w-7xl mx-auto px-6 py-20">

        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            const evtSource = new EventSource('/api/admin/updates');
            evtSource.onmessage = (event) => {
              if (event.data === 'update') {
                window.location.reload();
              }
            };
          })();
        `}} />
        <header class="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-16">
          <h1 class="text-5xl font-black tracking-tight mb-2">Admin <span class="text-red-700">Control</span></h1>
          <div class="flex flex-wrap gap-4">
            <a href="/admin/visitors" class="px-6 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold hover:bg-white/10 transition-all">Visitors</a>
            <a href="/admin/settings" class="px-6 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold hover:bg-white/10 transition-all">Home Settings</a>
            <a href="/admin/blog/new" class="px-6 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold hover:bg-white/10 transition-all">+ New Post</a>
            <a href="/admin/projects/new" class="px-6 py-3 bg-red-700 text-white rounded-xl text-sm font-bold hover:bg-red-800 transition-all btn-shadow">+ New Project</a>
            <a href="/admin/activities/new" class="px-6 py-3 bg-cyan-700 text-white rounded-xl text-sm font-bold hover:bg-cyan-800 transition-all">+ New Activity</a>
          </div>
        </header>

        {/* QUICK STATS & CV & TIMELINE */}
        <div class="grid lg:grid-cols-2 gap-12 mb-12">
          <div class="space-y-6">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2rem] backdrop-blur-xl">
                <p class="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Page Views</p>
                <h4 class="text-3xl sm:text-4xl font-black text-white">{totalViews[0]?.sum || 0}</h4>
              </div>
              <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2rem] backdrop-blur-xl">
                <p class="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Comments (7d)</p>
                <h4 class="text-3xl sm:text-4xl font-black text-cyan-400">+{recentComments.length}</h4>
              </div>
            </div>

            <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2rem] backdrop-blur-xl">
              {/* Timeline Milestones */}
              <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 sm:gap-0 mb-8">
                <h2 class="text-xl sm:text-2xl font-black italic">ACTIVITY <span class="text-red-700">TIMELINE</span></h2>
                <button onclick="document.getElementById('milestone-form').classList.toggle('hidden')" class="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-white/10 transition-all">+ Add Milestone</button>
              </div>

              <form id="milestone-form" action="/admin/milestones/save" method="post" class="hidden space-y-4 mb-8 bg-slate-950/50 p-6 rounded-2xl border border-white/5">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <input type="text" name="year" placeholder="Year (e.g. 2024)" required class="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white" />
                  <select name="type" class="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-slate-400">
                    <option value="work">Work</option>
                    <option value="education">Education</option>
                    <option value="achievement">Achievement</option>
                  </select>
                </div>
                <input type="text" name="title" placeholder="Title" required class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white" />
                <textarea name="description" placeholder="Short description" class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm min-h-[80px] text-white"></textarea>
                <button type="submit" class="w-full py-3 bg-red-700 text-white font-black rounded-xl text-xs uppercase tracking-widest">Save Milestone</button>
              </form>

              <div class="space-y-4 max-h-[300px] overflow-y-auto pr-2">
                {(await db.select().from(milestonesTable).orderBy(desc(milestonesTable.year))).map(m => (
                  <div class="flex justify-between items-center p-4 bg-slate-950/30 border border-white/5 rounded-xl">
                    <div>
                      <span class="text-[10px] font-black text-red-500 uppercase">{m.year}</span>
                      <h4 class="font-bold text-sm">{m.title}</h4>
                    </div>
                    <form action={`/admin/milestones/delete/${m.id}`} method="post">
                      <button type="submit" class="text-slate-600 hover:text-red-500 transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                      </button>
                    </form>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div class="space-y-6">
            <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2rem] backdrop-blur-xl">
              <h2 class="text-xl sm:text-2xl font-black italic mb-6">RESUME / <span class="text-red-700">CV</span></h2>
              <form action="/admin/settings/cv" method="post" class="flex flex-col sm:flex-row gap-4">
                <input type="url" name="cv_url" value={(await db.select().from(settingsTable).where(eq(settingsTable.key, 'cv_url')).limit(1))[0]?.value || ''} placeholder="https://drive.google.com/..." class="flex-grow bg-slate-950/50 border border-white/10 rounded-xl px-4 sm:px-6 py-3 sm:py-4 text-slate-300 focus:outline-none focus:border-red-500" />
                <button type="submit" class="px-8 py-3 sm:py-4 bg-red-700 hover:bg-red-800 text-white font-black rounded-xl transition-all uppercase text-xs tracking-widest">Update</button>
              </form>
            </div>

            <div class="bg-white/5 border border-white/10 rounded-[2.5rem] p-6 sm:p-8 backdrop-blur-xl h-full">
              <h2 class="text-xl sm:text-2xl font-black italic mb-8">NEWSLETTER <span class="text-cyan-500">SUBSCRIBERS</span></h2>
              <div class="flex flex-wrap gap-4 max-h-[160px] overflow-y-auto pr-2">
                {totalSubs.map(sub => (
                  <div class="px-4 py-2 bg-slate-950/50 border border-white/5 rounded-xl flex items-center gap-4">
                    <span class="text-sm font-bold text-slate-300">{sub.email}</span>
                  </div>
                ))}
                {totalSubs.length === 0 && <p class="text-slate-500 font-bold italic">No subscribers yet</p>}
              </div>
            </div>
          </div>
        </div>

        <section class="mb-12 rounded-[2.5rem] border border-white/10 bg-white/5 p-6 backdrop-blur-xl sm:p-8">
          <div class="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div><h2 class="text-xl font-black italic sm:text-2xl">CONTENT <span class="text-cyan-400">OVERVIEW</span></h2><p class="mt-2 text-sm text-slate-500">Kelola konten lengkap melalui menu masing-masing.</p></div>
            <a href="/" class="text-xs font-black uppercase tracking-widest text-slate-500 hover:text-white">View public site →</a>
          </div>
          <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
            <a href="/admin/blog/new" class="rounded-2xl border border-white/10 bg-slate-950/40 p-5 transition-all hover:border-red-500/40"><p class="text-2xl font-black text-white">{posts.length}</p><p class="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Blog posts</p></a>
            <a href="/admin/projects/new" class="rounded-2xl border border-white/10 bg-slate-950/40 p-5 transition-all hover:border-red-500/40"><p class="text-2xl font-black text-white">{projects.length}</p><p class="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Projects</p></a>
            <a href="/admin/activities" class="rounded-2xl border border-white/10 bg-slate-950/40 p-5 transition-all hover:border-cyan-500/40"><p class="text-2xl font-black text-white">{activities.length}</p><p class="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Jejak</p></a>
            <a href="/admin/inbox" class="rounded-2xl border border-white/10 bg-slate-950/40 p-5 transition-all hover:border-cyan-500/40"><p class="text-2xl font-black text-white">{messages.length}</p><p class="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Inbox</p></a>
          </div>
        </section>

        <section class="grid gap-6 lg:grid-cols-2">
          <div class="rounded-[2.5rem] border border-white/10 bg-white/5 p-6 backdrop-blur-xl sm:p-8">
            <div class="mb-6 flex items-center justify-between gap-4"><div><h2 class="text-xl font-black italic">BLOG <span class="text-red-500">POSTS</span></h2><p class="mt-2 text-xs text-slate-500">Pilih post untuk mengedit isinya.</p></div><a href="/admin/blog/new" class="shrink-0 rounded-xl bg-red-700 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white transition-colors hover:bg-red-800">+ Baru</a></div>
            <div class="max-h-[420px] space-y-3 overflow-y-auto pr-1">
              {posts.map(post => <div class="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/40 p-4 sm:flex-row sm:items-center"><div class="min-w-0 flex-1"><p class="line-clamp-2 break-words text-sm font-bold leading-relaxed text-slate-200">{post.title}</p><div class="mt-2 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest"><span class={post.status === 'published' ? 'text-green-400' : 'text-slate-500'}>{post.status === 'published' ? 'Published' : 'Draft'}</span>{post.category && <span class="max-w-full truncate text-slate-600">• {post.category}</span>}</div></div><a href={`/admin/blog/edit/${post.id}`} class="w-full rounded-lg border border-red-500/30 px-3 py-3 text-center text-[10px] font-black uppercase tracking-widest text-red-300 transition-colors hover:bg-red-500/10 hover:text-white sm:w-auto sm:shrink-0">Edit</a></div>)}
              {posts.length === 0 && <p class="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm italic text-slate-500">Belum ada post.</p>}
            </div>
          </div>

          <div class="rounded-[2.5rem] border border-white/10 bg-white/5 p-6 backdrop-blur-xl sm:p-8">
            <div class="mb-6 flex items-center justify-between gap-4"><div><h2 class="text-xl font-black italic">PORTFOLIO <span class="text-red-500">PROJECTS</span></h2><p class="mt-2 text-xs text-slate-500">Pilih project untuk mengedit detailnya.</p></div><a href="/admin/projects/new" class="shrink-0 rounded-xl bg-red-700 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white transition-colors hover:bg-red-800">+ Baru</a></div>
            <div class="max-h-[420px] space-y-3 overflow-y-auto pr-1">
              {projects.map(project => <div class="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/40 p-4 sm:flex-row sm:items-center"><div class="min-w-0 flex-1"><p class="line-clamp-2 break-words text-sm font-bold leading-relaxed text-slate-200">{project.title}</p><p class="mt-2 truncate text-[10px] font-black uppercase tracking-widest text-slate-500">{project.slug || 'Tanpa slug'}</p></div><a href={`/admin/projects/edit/${project.id}`} class="w-full rounded-lg border border-red-500/30 px-3 py-3 text-center text-[10px] font-black uppercase tracking-widest text-red-300 transition-colors hover:bg-red-500/10 hover:text-white sm:w-auto sm:shrink-0">Edit</a></div>)}
              {projects.length === 0 && <p class="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm italic text-slate-500">Belum ada project.</p>}
            </div>
          </div>
        </section>

      </div>
      </AdminLayout>
  );
});

// --- VISITOR PROFILING ---
app.get('/api/profile/check', async (c) => {
  const user = c.var.user;
  if (!user || user.role !== 'visitor') return c.json({ missing: false });
  
  const profile = await db.select().from(profileTable).where(eq(profileTable.email, user.email)).get();
  return c.json({ missing: !profile });
});

app.post('/api/profile/save', async (c) => {
  const user = c.var.user;
  if (!user) return c.redirect('/admin/login');

  const body = await c.req.parseBody();

  await db.insert(profileTable).values({
    email: user.email,
    fullName: body.fullName as string,
    province: body.provinceName as string,
    regency: body.regencyName as string,
    district: body.districtName as string,
    occupation: body.occupation as string,
  });

  return c.redirect(c.req.header('referer') || '/');
});

app.post('/api/integrations/telegram/blog', async (c) => {
  const auth = c.req.header('authorization') || '';
  const expected = process.env.TELEGRAM_BOT_ADMIN_TOKEN;
  if (!expected || auth !== `Bearer ${expected}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const payload = await c.req.json().catch(() => null) as any;
  const schema = zod.object({
    title: zod.string().min(1).max(200),
    content: zod.string().min(1),
    category: zod.string().max(60).optional(),
    tags: zod.string().max(200).optional(),
    coverImage: zod.string().max(500).optional(),
    status: zod.enum(['draft', 'published']).optional(),
    slug: zod.string().max(220).optional(),
  });

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', issues: parsed.error.issues }, 400);
  }

  const data = parsed.data;
  const slug = data.slug || data.title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) + '-' + Date.now().toString(36);

  await db.insert(blogPosts).values({
    title: data.title,
    slug,
    content: data.content,
    category: data.category,
    tags: data.tags,
    coverImage: data.coverImage,
    status: data.status || 'draft',
    updatedAt: new Date(),
  });

  return c.json({ ok: true, slug });
});

app.get('/admin/visitors', async (c) => {
  const user = c.var.user;
  const visitorProfiles = await db.select().from(profileTable).orderBy(desc(profileTable.createdAt));
  
  // Advanced Stats
  const provinceStats = await db.select({ province: profileTable.province, count: sql<number>`count(*)` }).from(profileTable).groupBy(profileTable.province).orderBy(desc(sql`count(*)`));
  const occupationStats = await db.select({ occupation: profileTable.occupation, count: sql<number>`count(*)` }).from(profileTable).groupBy(profileTable.occupation).orderBy(desc(sql`count(*)`));

  return c.html(
    <AdminLayout title="Visitor Insights | Admin" user={user} currentPath="/admin/visitors">
      <div class="max-w-7xl mx-auto px-6 py-20">
        <header class="mb-16 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <h1 class="text-5xl font-black mb-2">Visitor <span class="text-red-700">Insights</span></h1>
            <p class="text-slate-500 font-bold uppercase tracking-widest text-xs">Total of {visitorProfiles.length} registered researchers.</p>
          </div>
          <a href="/admin" class="px-6 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold hover:bg-white/10 transition-all flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            Back to Dashboard
          </a>
        </header>

        {/* STATS CARDS */}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
          <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2rem] backdrop-blur-xl">
            <p class="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Total Visitors</p>
            <h4 class="text-3xl sm:text-4xl font-black">{visitorProfiles.length}</h4>
          </div>
          {provinceStats.slice(0, 3).map(stat => (
            <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2rem] backdrop-blur-xl">
              <p class="text-[10px] font-black text-red-500 uppercase tracking-widest mb-2">{stat.province || 'Unknown'}</p>
              <h4 class="text-3xl sm:text-4xl font-black">{stat.count} <span class="text-xs text-slate-500">Profiles</span></h4>
            </div>
          ))}
        </div>

        <div class="grid lg:grid-cols-3 gap-12 mb-12">
          <div class="lg:col-span-2 space-y-8">
            {/* SEARCH & FILTER UI */}
            <div class="bg-white/5 border border-white/10 p-6 rounded-[2.5rem] backdrop-blur-xl flex flex-col sm:flex-row gap-4 items-stretch sm:items-center">
              <div class="flex-grow relative w-full">
                <input id="v-search" type="text" placeholder="Search by name, occupation, or location..." class="w-full bg-slate-950/50 border border-white/10 rounded-xl px-12 py-3 text-sm focus:border-red-500 transition-all outline-none" />
                <svg class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              </div>
              <select id="v-prov-filter" class="w-full sm:w-auto bg-slate-950/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-slate-300 outline-none focus:border-red-500">
                <option value="all">All Provinces</option>
                {provinceStats.map(s => <option value={s.province}>{s.province}</option>)}
              </select>
            </div>

            <div class="space-y-4" id="visitor-list">
              {visitorProfiles.map(p => (
                <div class="bg-white/5 border border-white/10 p-6 rounded-[2rem] backdrop-blur-xl flex flex-col md:flex-row md:items-center justify-between gap-6 hover:border-red-500/30 transition-all duration-300 group v-row" data-search={`${p.fullName} ${p.occupation} ${p.province} ${p.regency} ${p.district}`.toLowerCase()} data-province={p.province}>
                  
                  <div class="flex items-start md:items-center gap-5">
                    <div class="w-14 h-14 rounded-full bg-red-900/20 flex-shrink-0 flex items-center justify-center border border-red-500/30 group-hover:scale-110 group-hover:bg-red-900/40 transition-all duration-500">
                      <span class="text-red-500 font-black text-xl">{p.fullName[0].toUpperCase()}</span>
                    </div>
                    <div>
                      <h4 class="font-bold text-white text-lg group-hover:text-red-400 transition-colors">{p.fullName}</h4>
                      <p class="text-xs text-slate-400 mt-0.5">{p.email}</p>
                      <div class="mt-3 flex flex-wrap gap-2">
                        <span class="px-3 py-1 bg-red-500/10 border border-red-500/20 rounded-lg text-[9px] font-black text-red-500 uppercase tracking-widest shadow-sm">{p.occupation}</span>
                        <span class="px-3 py-1 bg-white/5 border border-white/10 rounded-lg text-[9px] font-bold text-slate-400 uppercase tracking-widest shadow-sm">{p.province}</span>
                      </div>
                    </div>
                  </div>

                  <div class="flex flex-row md:flex-col justify-between md:justify-center items-center md:items-end gap-2 md:gap-3 pt-5 md:pt-0 border-t border-white/10 md:border-0 w-full md:w-auto">
                    <div class="text-left md:text-right">
                      <p class="text-xs font-bold text-slate-300">{p.district}, {p.regency}</p>
                      <p class="text-[10px] text-slate-500 uppercase tracking-tight flex items-center md:justify-end gap-1.5 mt-1">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                        Location
                      </p>
                    </div>
                    <div class="text-right">
                      <p class="text-xs text-slate-300 font-bold">{new Date(p.createdAt!).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                      <p class="text-[10px] text-slate-500 uppercase tracking-tight mt-1 flex items-center justify-end gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        Joined
                      </p>
                    </div>
                  </div>

                </div>
              ))}
              {visitorProfiles.length === 0 && (
                <div class="bg-white/5 border border-dashed border-white/10 p-12 rounded-[2.5rem] text-center">
                  <div class="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4 border border-white/10">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-slate-500"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                  </div>
                  <p class="text-slate-400 font-bold tracking-widest text-sm uppercase">No visitors found</p>
                </div>
              )}
            </div>
          </div>

          <div class="space-y-8">
            <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2.5rem] backdrop-blur-xl">
              <h3 class="text-lg sm:text-xl font-black italic mb-6">OCCUPATION <span class="text-red-700">MIX</span></h3>
              <div class="space-y-4">
                {occupationStats.map(stat => (
                  <div>
                    <div class="flex justify-between text-[10px] font-black uppercase tracking-widest mb-2">
                      <span class="text-slate-400">{stat.occupation}</span>
                      <span class="text-red-500">{Math.round((stat.count / visitorProfiles.length) * 100)}%</span>
                    </div>
                    <div class="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                      <div class="h-full bg-red-700 rounded-full" style={{ width: `${(stat.count / visitorProfiles.length) * 100}%` }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            
            <div class="bg-white/5 border border-white/10 p-6 sm:p-8 rounded-[2.5rem] backdrop-blur-xl">
              <h3 class="text-lg sm:text-xl font-black italic mb-6">REGIONAL <span class="text-cyan-500">DENSITY</span></h3>
              <div class="space-y-4">
                {provinceStats.map(stat => (
                  <div class="flex items-center justify-between p-4 bg-slate-950/50 rounded-xl border border-white/5">
                    <span class="text-xs font-bold text-slate-300">{stat.province}</span>
                    <span class="px-3 py-1 bg-cyan-900/20 text-cyan-500 text-[10px] font-black rounded-lg">{stat.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            const searchInput = document.getElementById('v-search');
            const provFilter = document.getElementById('v-prov-filter');
            const rows = document.querySelectorAll('.v-row');

            const filter = () => {
              const query = searchInput.value.toLowerCase();
              const province = provFilter.value;

              rows.forEach(row => {
                const matchesSearch = row.getAttribute('data-search').includes(query);
                const matchesProv = province === 'all' || row.getAttribute('data-province') === province;
                row.style.display = (matchesSearch && matchesProv) ? '' : 'none';
              });
            };

            searchInput.addEventListener('input', filter);
            provFilter.addEventListener('change', filter);
          })();
        `}} />
      </div>
      </AdminLayout>
  );
});

// --- BLOG ADMIN ---
app.get('/admin/blog/new', (c) => renderBlogForm(c, null, c.var.user));
app.get('/admin/blog/edit/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const results = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
  return renderBlogForm(c, results[0], c.var.user);
});

function renderBlogForm(c: any, post: any = null, user: any = null) {
  const inputClass = "peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent";
  const labelClass = "absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-slate-500 peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-placeholder-shown:lowercase peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500 peer-focus:uppercase peer-focus:font-bold peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:text-red-500 peer-[:not(:placeholder-shown)]:uppercase peer-[:not(:placeholder-shown)]:font-bold";

  return c.html(
    <AdminLayout title={`${post ? 'Edit' : 'New'} Post | Admin`} user={user} currentPath="/admin/blog" showNavigation={false}>
      <div class="max-w-4xl mx-auto px-6 pt-10 pb-32">

        <h1 class="text-4xl font-black mb-12 italic tracking-tight">{post ? 'EDIT' : 'NEW'} <span class="text-red-700">POST</span></h1>
        <form id="blog-form" action="/admin/blog/save" method="post" enctype="multipart/form-data" class="space-y-8 bg-white/5 p-8 rounded-[2.5rem] border border-white/10 backdrop-blur-xl">
          {post && <input type="hidden" name="id" value={post.id} />}
          
          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative">
              <input type="text" name="title" id="title" value={post?.title || ''} placeholder=" " required class={inputClass} />
              <label for="title" class={labelClass}>Post Title</label>
            </div>
            <div class="relative">
              <input type="text" name="slug" id="slug" value={post?.slug || ''} placeholder=" " required class={inputClass} />
              <label for="slug" class={labelClass}>Slug</label>
            </div>
          </div>

          <div class="relative">
            <textarea name="content" id="content-input" placeholder=" " required class={`${inputClass} leading-relaxed min-h-[400px] font-mono text-sm`}>{post?.content || ''}</textarea>
            <label for="content-input" class={labelClass}>Markdown Content</label>
          </div>

          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative">
              <input type="text" name="category" id="cat" value={post?.category || ''} placeholder=" " class={inputClass} />
              <label for="cat" class={labelClass}>Category</label>
            </div>
            <div class="relative">
              <input type="text" name="coverImage" id="cover" value={post?.coverImage || ''} placeholder=" " class={inputClass} />
              <label for="cover" class={labelClass}>Cover Image URL</label>
            </div>
          </div>
          <div class="relative space-y-2 mt-4">
            <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Atau Upload Cover Image Baru <span class="text-cyan-400">(otomatis WebP)</span></label>
            <input type="file" name="coverImageFile" accept="image/jpeg,image/png,image/webp" class="w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-red-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white hover:file:bg-red-800 cursor-pointer transition-all" />
          </div>

          <div class="relative">
            <select name="status" id="status" class={inputClass}>
              <option value="draft" selected={post?.status === 'draft'}>Draft</option>
              <option value="published" selected={post?.status === 'published'}>Published</option>
            </select>
            <label for="status" class={labelClass}>Status</label>
          </div>

          <div class="flex gap-4 pt-4">
            <button id="submit-btn" type="submit" class="px-10 py-4 bg-red-700 text-white font-black rounded-xl btn-shadow hover:scale-[1.02] disabled:opacity-50 disabled:scale-100 transition-all tracking-widest uppercase relative overflow-hidden group">
              <span id="btn-text" class="transition-opacity">SAVE POST</span>
              <div id="btn-loader" class="absolute inset-0 flex items-center justify-center bg-red-900 opacity-0 pointer-events-none transition-opacity">
                <span id="loader-msg" class="text-sm font-black">UPLOADING...</span>
              </div>
            </button>
            <a href="/admin" class="px-10 py-4 border border-white/10 rounded-xl font-black text-slate-400 hover:text-white transition-all text-center flex items-center justify-center">CANCEL</a>
          </div>
        </form>

        <script dangerouslySetInnerHTML={{ __html: `
          const form = document.getElementById('blog-form');
          const fileInput = document.querySelector('input[type="file"]');
          const btn = document.getElementById('submit-btn');
          const btnText = document.getElementById('btn-text');
          const btnLoader = document.getElementById('btn-loader');
          const loaderMsg = document.getElementById('loader-msg');
          
          form.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            if (fileInput.files.length > 0) {
              loaderMsg.innerHTML = '<span class="animate-pulse">UPLOADING TO RUSTFS...</span>';
            } else {
              loaderMsg.innerHTML = '<span class="animate-pulse">SAVING...</span>';
            }
            
            btn.disabled = true;
            btnText.style.opacity = '0';
            btnLoader.style.opacity = '1';
            
            try {
              const formData = new FormData(form);
              const res = await fetch(form.action, {
                method: 'POST',
                body: formData
              });
              
              if (res.ok) {
                loaderMsg.innerHTML = '<span class="text-green-400">SUCCESS!</span>';
                setTimeout(() => window.location.href = '/admin', 800);
              } else {
                const errorText = await res.text();
                alert('Upload Gagal: ' + errorText);
                btn.disabled = false;
                btnText.style.opacity = '1';
                btnLoader.style.opacity = '0';
              }
            } catch (err) {
              alert('Network Error: ' + err.message);
              btn.disabled = false;
              btnText.style.opacity = '1';
              btnLoader.style.opacity = '0';
            }
          });
        `}} />
      </div>
      </AdminLayout>
  );
}

// --- HELPERS & SERVICES ---
const s3Client = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || '',
  },
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
});

async function uploadToS3(file: File, folder: string): Promise<string> {
  const maxSize = 10 * 1024 * 1024;
  const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (!supportedTypes.has(file.type)) {
    throw new Error('Format gambar harus JPG, PNG, atau WebP.');
  }
  if (file.size > maxSize) {
    throw new Error('Ukuran gambar maksimal 10 MB.');
  }

  const optimizedImage = await sharp(Buffer.from(await file.arrayBuffer()), {
    failOn: 'error',
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();

  const key = `${folder}/${Date.now()}-${crypto.randomUUID()}.webp`;
  
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: optimizedImage,
    ContentType: 'image/webp',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  const baseUrl = process.env.S3_PUBLIC_BASE_URL?.replace(/\/$/, '');
  const bucket = process.env.S3_BUCKET;
  return `${baseUrl}/${bucket}/${key}`;
}

async function notifySubscribers(post: { title: string; slug: string }) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('[Newsletter] No RESEND_API_KEY found. Skipping real email sending.');
      return;
    }

    const subscribers = await db.select().from(subTable);
    console.log(`[Newsletter] Sending real emails to ${subscribers.length} subscribers...`);

    const baseUrl = process.env.BASE_URL || 'http://localhost:4128';

    for (const sub of subscribers) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Ferilee <newsletter@ferilee.gurumuda.eu.org>',
          to: sub.email,
          subject: `New Blog Post: ${post.title}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: white; padding: 40px; border-radius: 20px;">
              <h1 style="color: #22d3ee; margin-bottom: 20px;">${post.title}</h1>
              <p style="color: #94a3b8; font-size: 16px; line-height: 1.6;">Hi there! I just published a new article that might interest you.</p>
              <div style="margin: 30px 0;">
                <a href="${baseUrl}/blog/${post.slug}" style="background: #22d3ee; color: #000; padding: 12px 24px; border-radius: 8px; font-weight: bold; text-decoration: none; display: inline-block;">Read Article</a>
              </div>
              <hr style="border: 0; border-top: 1px solid #1e293b; margin: 30px 0;" />
              <p style="color: #64748b; font-size: 12px;">You are receiving this because you subscribed to Ferilee's Newsletter.</p>
            </div>
          `
        }),
      });

      const resData = await response.json();
      if (!response.ok) {
        console.error(`[Newsletter Error] Resend API failed for ${sub.email}:`, resData);
      } else {
        console.log(`[Newsletter] Email sent to ${sub.email}. ID: ${resData.id}`);
      }
    }

    console.log(`[Newsletter] Successfully notified all subscribers.`);
  } catch (error) {
    console.error('[Newsletter Error] Failed to send emails:', error);
  }
}

app.post('/admin/blog/save', async (c) => {
  const body = await c.req.parseBody();
  const id = body.id ? parseInt(body.id as string) : null;
  const coverImageFile = body.coverImageFile;
  let coverImage = (body.coverImage as string) || '';
  try {
    if (coverImageFile instanceof File && coverImageFile.size > 0) {
      coverImage = await uploadToS3(coverImageFile, 'blog-covers');
    }
  } catch (err: any) {
    return c.text(err.message || 'Failed to upload to RustFS', 500);
  }
  const data = {
    title: body.title as string,
    slug: body.slug as string,
    content: body.content as string,
    category: body.category as string,
    coverImage,
    status: body.status as any,
    updatedAt: new Date(),
  };
  if (id) {
    const oldPost = await db.select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
    await db.update(blogPosts).set(data).where(eq(blogPosts.id, id));
    
    // Notify only if status changed from draft to published
    if (oldPost[0]?.status !== 'published' && data.status === 'published') {
      await notifySubscribers(data);
    }
  } else {
    await db.insert(blogPosts).values({ ...data, createdAt: new Date() });
    if (data.status === 'published') {
      await notifySubscribers(data);
    }
  }
  return c.redirect('/admin');
});
app.post('/admin/blog/delete/:id', async (c) => {
  await db.delete(blogPosts).where(eq(blogPosts.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin');
});

// --- PROJECTS ADMIN ---
app.get('/admin/projects/new', (c) => renderProjectForm(c, null, c.var.user));
app.get('/admin/projects/edit/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const results = await db.select().from(projectTable).where(eq(projectTable.id, id)).limit(1);
  return renderProjectForm(c, results[0], c.var.user);
});

app.post('/admin/projects/save', async (c) => {
  const body = await c.req.parseBody();
  const id = body.id ? parseInt(body.id as string) : null;
  const projectImageFile = body.projectImageFile;
  let image = (body.image as string) || '';
  try {
    if (projectImageFile instanceof File && projectImageFile.size > 0) {
      image = await uploadToS3(projectImageFile, 'project-thumbnails');
    }
  } catch (err: any) {
    return c.text(err.message || 'Failed to upload to RustFS', 500);
  }
  const data = {
    title: body.title as string,
    slug: body.slug as string,
    description: body.description as string,
    content: body.content as string,
    image,
    techStack: body.techStack as string,
    link: body.link as string,
    github: body.github as string,
  };
  if (id) {
    await db.update(projectTable).set(data).where(eq(projectTable.id, id));
  } else {
    await db.insert(projectTable).values(data);
  }
  return c.redirect('/admin');
});
app.post('/admin/projects/delete/:id', async (c) => {
  await db.delete(projectTable).where(eq(projectTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin');
});

// --- PARTICIPANT WORKS ADMIN ---
app.get('/admin/works', async (c) => {
  const user = c.var.user;
  const selectedActivityId = Number(c.req.query('activityId')) || null;
  const activities = await db.select().from(activityTable).orderBy(desc(activityTable.eventDate));
  const works = await db.select().from(participantWorkTable).orderBy(desc(participantWorkTable.createdAt));
  const activitiesById = new Map(activities.map(activity => [activity.id, activity]));
  const filteredWorks = selectedActivityId ? works.filter(work => work.activityId === selectedActivityId) : works;
  const unreadCount = await getAdminNotificationCount();

  return c.html(
    <AdminLayout title="Participant Works | Admin" notificationCount={unreadCount} user={user} currentPath="/admin/activities">
      <div class="mx-auto max-w-7xl px-6 py-10 md:py-16">
        <header class="mb-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between"><div><a href="/admin/activities" class="text-xs font-black uppercase tracking-widest text-cyan-400 hover:text-white">← Jejak Activities</a><h1 class="mt-5 text-4xl font-black italic tracking-tight md:text-5xl">KARYA <span class="text-cyan-400">PESERTA</span></h1><p class="mt-3 max-w-xl text-slate-500">Tinjau dan kelola karya peserta yang akan ditampilkan pada public showcase.</p></div><a href={`/admin/works/new${selectedActivityId ? `?activityId=${selectedActivityId}` : ''}`} class="rounded-xl bg-cyan-700 px-5 py-3 text-center text-xs font-black uppercase tracking-widest text-white transition-all hover:bg-cyan-800">+ New Work</a></header>
        <div class="mb-8 flex flex-wrap gap-2"><a href="/admin/works" class={`rounded-xl px-4 py-2.5 text-xs font-black uppercase tracking-widest ${!selectedActivityId ? 'bg-cyan-500/15 text-cyan-300' : 'border border-white/10 text-slate-500 hover:text-white'}`}>Semua karya</a>{activities.map(activity => <a href={`/admin/works?activityId=${activity.id}`} class={`rounded-xl px-4 py-2.5 text-xs font-bold ${selectedActivityId === activity.id ? 'bg-cyan-500/15 text-cyan-300' : 'border border-white/10 text-slate-500 hover:text-white'}`}>{activity.title}</a>)}</div>
        <section class="space-y-4">{filteredWorks.map(work => { const activity = activitiesById.get(work.activityId); return <article class="flex flex-col gap-5 rounded-2xl border border-white/10 bg-white/5 p-5 transition-all hover:border-cyan-500/30 md:flex-row md:items-center md:justify-between md:p-6"><div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h2 class="font-black text-white">{work.title}</h2><span class={`rounded-md px-2 py-1 text-[9px] font-black uppercase ${work.status === 'published' ? 'bg-green-900/30 text-green-400' : 'bg-amber-900/30 text-amber-400'}`}>{work.status || 'draft'}</span>{work.consent && <span class="rounded-md bg-cyan-900/30 px-2 py-1 text-[9px] font-black uppercase text-cyan-400">Consent</span>}</div><p class="mt-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">{work.participantName}{work.institution ? ` • ${work.institution}` : ''}</p><p class="mt-2 text-xs font-bold text-cyan-400/80">{activity?.title || 'Activity unavailable'}</p>{work.description && <p class="mt-3 line-clamp-2 text-sm text-slate-400">{work.description}</p>}</div><div class="flex shrink-0 items-center gap-2"><a href={work.workUrl || (activity ? `/jejak/${activity.slug}#karya-peserta` : '#')} target="_blank" rel="noreferrer" class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-400 hover:text-white">View ↗</a><a href={`/admin/works/edit/${work.id}`} class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-400 hover:text-white">Edit</a><form action={`/admin/works/delete/${work.id}`} method="post" onsubmit="return confirm('Delete this participant work?')"><button type="submit" class="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-bold text-slate-500 hover:border-red-500/30 hover:text-red-400">Delete</button></form></div></article>; })}{filteredWorks.length === 0 && <div class="rounded-2xl border border-dashed border-white/10 p-16 text-center text-sm font-bold text-slate-500">Belum ada karya peserta pada filter ini.</div>}</section>
      </div>
    </AdminLayout>
  );
});

app.get('/admin/works/new', async (c) => {
  const activities = await db.select().from(activityTable).orderBy(desc(activityTable.eventDate));
  return renderParticipantWorkForm(c, null, activities, Number(c.req.query('activityId')) || null, c.var.user);
});

app.get('/admin/works/edit/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const results = await db.select().from(participantWorkTable).where(eq(participantWorkTable.id, id)).limit(1);
  if (!results[0]) return c.notFound();
  const activities = await db.select().from(activityTable).orderBy(desc(activityTable.eventDate));
  return renderParticipantWorkForm(c, results[0], activities, results[0].activityId, c.var.user);
});

app.post('/admin/works/save', async (c) => {
  const body = await c.req.parseBody();
  const id = body.id ? parseInt(String(body.id)) : null;
  const activityId = Number(body.activityId);
  const title = String(body.title || '').trim();
  const participantName = String(body.participantName || '').trim();
  const previewImageFile = body.previewImageFile;
  let previewImage = normalizeHttpUrl(String(body.previewImage || '').trim());

  if (!activityId || !title || !participantName) return c.text('Activity, title, and participant name are required.', 400);

  try {
    if (previewImageFile instanceof File && previewImageFile.size > 0) {
      previewImage = await uploadToS3(previewImageFile, 'participant-work-previews');
    }
  } catch (error: any) {
    return c.text(error.message || 'Failed to upload participant work preview', 500);
  }

  const consent = body.consent === 'on' || body.consent === 'true';
  const data = {
    activityId,
    title,
    participantName,
    institution: String(body.institution || '').trim() || null,
    description: String(body.description || '').trim() || null,
    previewImage,
    workUrl: normalizeHttpUrl(String(body.workUrl || '').trim()),
    tags: String(body.tags || '').trim() || null,
    status: body.status === 'published' && consent ? 'published' as const : 'draft' as const,
    consent,
    sortOrder: Number(body.sortOrder) || 0,
    updatedAt: new Date(),
  };

  if (id) {
    await db.update(participantWorkTable).set(data).where(eq(participantWorkTable.id, id));
  } else {
    await db.insert(participantWorkTable).values({ ...data, submittedAt: new Date(), createdAt: new Date() });
  }
  adminUpdates.emit('update');
  return c.redirect('/admin/works');
});

app.post('/admin/works/delete/:id', async (c) => {
  await db.delete(participantWorkTable).where(eq(participantWorkTable.id, parseInt(c.req.param('id'))));
  adminUpdates.emit('update');
  return c.redirect('/admin/works');
});

// --- ACTIVITIES ADMIN ---
app.get('/admin/activities/new', (c) => renderActivityForm(c, null, [], [], c.var.user));
app.get('/admin/activities/edit/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const results = await db.select().from(activityTable).where(eq(activityTable.id, id)).limit(1);
  const media = await db.select().from(activityMediaTable).where(eq(activityMediaTable.activityId, id)).orderBy(activityMediaTable.sortOrder);
  const links = await db.select().from(activityLinkTable).where(eq(activityLinkTable.activityId, id)).orderBy(activityLinkTable.sortOrder);
  return renderActivityForm(c, results[0], media, links, c.var.user);
});

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseJakartaDateTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) - (7 * 60 * 60 * 1000);
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatJakartaDateTime(value: Date | number | string | null | undefined) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function formatJakartaBadge(value: Date | number | string | null | undefined) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.day} ${parts.month} ${parts.year} · ${parts.hour}.${parts.minute} WIB`;
}

function normalizeLinkSchedule(fromValue: string, untilValue: string) {
  const availableFrom = parseJakartaDateTime(fromValue);
  const availableUntil = parseJakartaDateTime(untilValue);
  if (availableFrom && availableUntil && availableUntil.getTime() <= availableFrom.getTime()) {
    return { availableFrom, availableUntil, error: 'Waktu selesai harus setelah waktu mulai.' };
  }
  return { availableFrom, availableUntil, error: null };
}

type ScheduledActivityLink = {
  label: string;
  url: string;
  availableFrom?: Date | number | string | null;
  availableUntil?: Date | number | string | null;
  accent?: boolean;
};

function renderScheduledActivityLink(link: ScheduledActivityLink) {
  const now = Date.now();
  const from = link.availableFrom ? new Date(link.availableFrom).getTime() : null;
  const until = link.availableUntil ? new Date(link.availableUntil).getTime() : null;
  const isBefore = from !== null && !Number.isNaN(from) && now < from;
  const isExpired = until !== null && !Number.isNaN(until) && now >= until;
  const baseClass = 'relative flex w-full min-h-[60px] items-center justify-center rounded-xl border px-4 pb-3 pt-6 text-center text-sm font-bold leading-snug transition-all';
  const activeClass = link.accent
    ? `${baseClass} border-cyan-500/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 hover:text-white`
    : `${baseClass} border-white/10 bg-white/5 hover:border-red-500/40 hover:bg-white/10`;
  const disabledClass = `${baseClass} cursor-not-allowed border-white/10 bg-white/[0.03] text-slate-500`;
  const badgeClass = 'pointer-events-none absolute right-3 top-2 max-w-[85%] truncate rounded-full border border-white/10 bg-slate-950/60 px-2 py-0.5 text-[9px] font-black tracking-wide text-slate-400';

  if (isBefore || isExpired) {
    const scheduleText = isBefore ? `Buka ${formatJakartaBadge(link.availableFrom)}` : 'Ditutup';
    const countdown = isBefore && from !== null && from - now <= 24 * 60 * 60 * 1000;
    return <div data-scheduled-link class="w-full min-w-0"><button type="button" disabled class={disabledClass}><span>{link.label}</span><svg aria-hidden="true" class="ml-1 h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="10" width="14" height="10" rx="2"></rect><path d="M8 10V8a4 4 0 0 1 8 0v2h-2V8a2 2 0 0 0-4 0v2z"></path></svg><span class={badgeClass}>{countdown ? <span data-link-countdown data-start={from}>{formatCountdown(from - now)} lagi</span> : scheduleText}</span></button></div>;
  }

  return <div data-scheduled-link class="w-full min-w-0"><a href={link.url} target="_blank" rel="noreferrer" class={activeClass}>{link.label} ↗{until !== null && <span class={badgeClass}>Sampai {formatJakartaBadge(link.availableUntil)}</span>}</a></div>;
}

function formatCountdown(milliseconds: number) {
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60000));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} hari ${hours} jam`;
  if (hours > 0) return `${hours} jam ${minutes} menit`;
  return `${minutes} menit`;
}

app.post('/admin/activities/save', async (c) => {
  const body = await c.req.parseBody({ all: true });
  const id = body.id ? parseInt(body.id as string) : null;
  const eventDate = String(body.eventDate || '');
  const title = String(body.title || '').trim();
  const slug = slugify(String(body.slug || title));
  const coverImageFile = body.coverImageFile;
  const galleryFilesValue = body.galleryFiles;
  const galleryFiles = (Array.isArray(galleryFilesValue) ? galleryFilesValue : [galleryFilesValue]).filter((file): file is File => file instanceof File && file.size > 0);
  let coverImage = String(body.coverImage || '').trim();
  let uploadedGalleryUrls: string[] = [];
  const linkLabels = Array.isArray(body.activityLinkLabel) ? body.activityLinkLabel : body.activityLinkLabel ? [body.activityLinkLabel] : [];
  const linkUrls = Array.isArray(body.activityLinkUrl) ? body.activityLinkUrl : body.activityLinkUrl ? [body.activityLinkUrl] : [];
  const linkAvailableFrom = Array.isArray(body.activityLinkAvailableFrom) ? body.activityLinkAvailableFrom : body.activityLinkAvailableFrom ? [body.activityLinkAvailableFrom] : [];
  const linkAvailableUntil = Array.isArray(body.activityLinkAvailableUntil) ? body.activityLinkAvailableUntil : body.activityLinkAvailableUntil ? [body.activityLinkAvailableUntil] : [];
  const additionalLinks: Array<{ label: string; url: string; availableFrom: Date | null; availableUntil: Date | null; sortOrder: number }> = [];
  let scheduleError: string | null = null;
  linkLabels.forEach((rawLabel, index) => {
    const label = String(rawLabel || '').trim();
    const url = normalizeHttpUrl(String(linkUrls[index] || '').trim());
    const schedule = normalizeLinkSchedule(String(linkAvailableFrom[index] || ''), String(linkAvailableUntil[index] || ''));
    if (schedule.error) scheduleError = schedule.error;
    if (label && url && !schedule.error) additionalLinks.push({ label, url, availableFrom: schedule.availableFrom, availableUntil: schedule.availableUntil, sortOrder: additionalLinks.length });
  });

  const materialSchedule = normalizeLinkSchedule(String(body.materialAvailableFrom || ''), String(body.materialAvailableUntil || ''));
  const certificateSchedule = normalizeLinkSchedule(String(body.certificateAvailableFrom || ''), String(body.certificateAvailableUntil || ''));
  const publicationSchedule = normalizeLinkSchedule(String(body.publicationAvailableFrom || ''), String(body.publicationAvailableUntil || ''));
  scheduleError = scheduleError || materialSchedule.error || certificateSchedule.error || publicationSchedule.error;

  if (!title || !slug || !eventDate || !body.role || !body.category || !body.summary) {
    return c.text('Title, date, role, category, and summary are required.', 400);
  }
  if (scheduleError) return c.text(scheduleError, 400);

  try {
    if (coverImageFile instanceof File && coverImageFile.size > 0) {
      coverImage = await uploadToS3(coverImageFile, 'activity-covers');
    }
    uploadedGalleryUrls = await Promise.all(galleryFiles.map(file => uploadToS3(file, 'activity-gallery')));
  } catch (err: any) {
    return c.text(err.message || 'Failed to upload activity media to RustFS', 500);
  }

  const data = {
    title,
    slug,
    eventDate,
    endDate: String(body.endDate || '').trim() || null,
    year: Number(body.year) || Number(eventDate.slice(0, 4)),
    location: String(body.location || '').trim() || null,
    organizer: String(body.organizer || '').trim() || null,
    role: String(body.role).trim(),
    category: String(body.category).trim(),
    summary: String(body.summary).trim(),
    description: String(body.description || '').trim() || null,
    coverImage: coverImage || null,
    galleryAlbumUrl: String(body.galleryAlbumUrl || '').trim() || null,
    materialUrl: String(body.materialUrl || '').trim() || null,
    materialAvailableFrom: materialSchedule.availableFrom,
    materialAvailableUntil: materialSchedule.availableUntil,
    certificateUrl: String(body.certificateUrl || '').trim() || null,
    certificateAvailableFrom: certificateSchedule.availableFrom,
    certificateAvailableUntil: certificateSchedule.availableUntil,
    publicationUrl: String(body.publicationUrl || '').trim() || null,
    publicationAvailableFrom: publicationSchedule.availableFrom,
    publicationAvailableUntil: publicationSchedule.availableUntil,
    featuredOnCv: body.featuredOnCv === 'on' || body.featuredOnCv === 'true',
    status: (body.status === 'published' ? 'published' : 'draft') as 'draft' | 'published',
    updatedAt: new Date(),
  };

  let activityId = id;
  if (id) {
    await db.update(activityTable).set(data).where(eq(activityTable.id, id));
    await db.delete(activityMediaTable).where(eq(activityMediaTable.activityId, id));
  } else {
    const inserted = await db.insert(activityTable).values({ ...data, createdAt: new Date() }).returning({ id: activityTable.id });
    activityId = inserted[0]?.id || null;
  }

  const galleryUrls = String(body.galleryUrls || '').split('\n').map(url => url.trim()).filter(Boolean);
  const allGalleryUrls = [...uploadedGalleryUrls, ...galleryUrls];
  if (activityId && allGalleryUrls.length > 0) {
    await db.insert(activityMediaTable).values(allGalleryUrls.map((url, index) => ({ activityId: activityId!, url, sortOrder: index, mediaType: 'image' })));
  }
  if (activityId) {
    await db.delete(activityLinkTable).where(eq(activityLinkTable.activityId, activityId));
    if (additionalLinks.length > 0) {
      await db.insert(activityLinkTable).values(additionalLinks.map(link => ({ ...link, activityId: activityId! })));
    }
  }
  adminUpdates.emit('update');
  return c.redirect('/admin');
});

app.post('/admin/activities/delete/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  await db.delete(activityMediaTable).where(eq(activityMediaTable.activityId, id));
  await db.delete(activityLinkTable).where(eq(activityLinkTable.activityId, id));
  await db.delete(activityTable).where(eq(activityTable.id, id));
  adminUpdates.emit('update');
  return c.redirect('/admin');
});

// --- CONTACT ADMIN ---
app.post('/admin/contacts/delete/:id', async (c) => {
  await db.delete(contactTable).where(eq(contactTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin/inbox');
});

app.post('/admin/contacts/read/:id', async (c) => {
  await db.update(contactTable).set({ isRead: 1 }).where(eq(contactTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin/inbox');
});

// --- SETTINGS ADMIN ---
app.get('/admin/settings', async (c) => {
  const user = c.var.user;
  const allSettings = await db.select().from(settingsTable);
  const settings = Object.fromEntries(allSettings.map(s => [s.key, s.value]));
  return renderSettingsForm(c, settings, user);
});


app.post('/admin/settings/save', async (c) => {
  const body = await c.req.parseBody();
  const keys = ['hero_title', 'hero_desc', 'phil_title', 'phil_desc'];
  
  for (const key of keys) {
    const value = body[key] as string;
    if (value !== undefined) {
      // Upsert logic for SQLite
      await db.insert(settingsTable)
        .values({ key, value })
        .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
    }
  }
  return c.redirect('/admin');
});

// --- HELPERS ---
// --- PROJECT ADMIN ---
app.get('/admin/projects/new', (c) => renderProjectForm(c, null, c.var.user));
app.get('/admin/projects/edit/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const results = await db.select().from(projectTable).where(eq(projectTable.id, id)).limit(1);
  return renderProjectForm(c, results[0], c.var.user);
});

function renderParticipantSubmission(c: any, activity: any) {
  const submitted = c.req.query('submitted') === '1';
  const errorType = c.req.query('error') || '';
  const hasError = Boolean(errorType);
  const errorMessage = errorType === 'evidence'
    ? 'Tambahkan URL karya atau unggah gambar preview agar karya dapat ditinjau.'
    : errorType === 'consent'
      ? 'Centang persetujuan publikasi sebelum mengirim karya.'
      : errorType === 'upload'
        ? 'Gambar preview gagal diunggah. Periksa format dan ukuran file, lalu coba lagi.'
        : 'Lengkapi nama peserta dan judul karya sebelum mengirim.';
  const fieldClass = 'w-full rounded-2xl border border-white/10 bg-slate-950/60 px-5 py-4 text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none';

  return c.html(
    <Layout title={'Kirim Karya | ' + activity.title} currentPath="/jejak">
      <div class="mx-auto max-w-3xl px-6 py-28 md:py-32">
        <a href={'/jejak/' + activity.slug + '#karya-peserta'} class="text-xs font-black uppercase tracking-widest text-red-500 transition-colors hover:text-white">← Kembali ke Aktivitas</a>
        {submitted ? (
          <div class="mt-10 rounded-3xl border border-cyan-500/20 bg-cyan-500/10 p-8 text-center md:p-12" role="status">
            <p class="text-xs font-black uppercase tracking-[0.3em] text-cyan-400">Pengiriman Diterima</p>
            <h1 class="mt-4 text-4xl font-black italic">KARYA <span class="text-cyan-400">DITERIMA</span></h1>
            <p class="mx-auto mt-5 max-w-xl leading-relaxed text-slate-400">Terima kasih. Karya Anda masuk ke antrean tinjauan dan akan ditampilkan setelah disetujui.</p>
            <a href={'/jejak/' + activity.slug + '#karya-peserta'} class="mt-8 inline-flex rounded-xl bg-cyan-700 px-5 py-3 text-xs font-black uppercase tracking-widest text-white transition-colors hover:bg-cyan-800">Kembali ke Aktivitas</a>
          </div>
        ) : (
          <>
            <header class="mt-8 border-b border-white/10 pb-8">
              <p class="text-xs font-black uppercase tracking-[0.3em] text-cyan-400">Ruang Karya Peserta</p>
              <h1 class="mt-4 text-4xl font-black italic md:text-6xl">KIRIM <span class="text-cyan-400">KARYA</span></h1>
              <p class="mt-5 leading-relaxed text-slate-400">Bagikan karya yang Anda hasilkan dalam kegiatan <span class="font-bold text-slate-200">{activity.title}</span>. Karya akan ditinjau sebelum ditampilkan secara publik.</p>
            </header>
            {hasError && <div role="alert" class="mt-8 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm font-bold text-red-300">{errorMessage}</div>}
            <form id="participant-submission-form" action={'/jejak/' + activity.slug + '/kirim-karya'} method="post" enctype="multipart/form-data" class="mt-8 space-y-6">
              <input type="text" name="website" tabIndex={-1} autoComplete="off" class="hidden" aria-hidden="true" />
              <div class="grid gap-6 md:grid-cols-2">
                <div><label for="participant-name" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">Nama peserta <span class="text-red-400">*</span></label><input id="participant-name" type="text" name="participantName" placeholder="Nama lengkap" required class={fieldClass} /></div>
                <div><label for="institution" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">Institusi <span class="font-normal normal-case tracking-normal text-slate-600">(opsional)</span></label><input id="institution" type="text" name="institution" placeholder="Nama sekolah atau lembaga" class={fieldClass} /></div>
              </div>
              <div><label for="work-title" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">Judul karya <span class="text-red-400">*</span></label><input id="work-title" type="text" name="title" placeholder="Contoh: Media Pembelajaran Interaktif" required class={fieldClass} /></div>
              <div><label for="work-description" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">Deskripsi karya <span class="font-normal normal-case tracking-normal text-slate-600">(opsional)</span></label><textarea id="work-description" name="description" placeholder="Ceritakan singkat ide atau proses karya ini" rows={5} class={fieldClass + ' min-h-[140px] leading-relaxed'}></textarea></div>
              <fieldset class="space-y-5 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-5">
                <legend class="px-2 text-xs font-black uppercase tracking-widest text-cyan-300">Bukti karya</legend>
                <p class="text-sm leading-relaxed text-slate-400">Isi minimal salah satu: URL karya atau gambar preview.</p>
                <div><label for="work-url" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">URL karya <span class="font-normal normal-case tracking-normal text-slate-600">(opsional jika ada preview)</span></label><input id="work-url" type="url" name="workUrl" placeholder="https://..." class={fieldClass} /></div>
                <div><label for="preview-image-url" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">URL gambar preview <span class="font-normal normal-case tracking-normal text-slate-600">(opsional)</span></label><input id="preview-image-url" type="url" name="previewImage" placeholder="https://..." class={fieldClass} /></div>
                <div><label for="preview-image-file" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">Unggah gambar preview <span class="font-normal normal-case tracking-normal text-slate-600">(opsional)</span></label><input id="preview-image-file" type="file" name="previewImageFile" accept="image/jpeg,image/png,image/webp" class="w-full rounded-2xl border border-white/10 bg-slate-950/60 px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white" /><p class="mt-2 text-xs leading-relaxed text-slate-500">JPG, PNG, atau WebP; maksimal 10 MB. Gambar otomatis dikonversi ke WebP.</p></div>
              </fieldset>
              <div><label for="work-tags" class="mb-2 block text-xs font-black uppercase tracking-widest text-slate-500">Kategori atau tag <span class="font-normal normal-case tracking-normal text-slate-600">(opsional)</span></label><input id="work-tags" type="text" name="tags" placeholder="Contoh: AI, Matematika, Canva" class={fieldClass} /></div>
              <label class="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-slate-400"><input type="checkbox" name="consent" required class="mt-1 h-5 w-5 shrink-0 accent-cyan-600" /><span>Saya menyetujui karya, nama, dan institusi saya ditampilkan di Ruang Karya Peserta setelah ditinjau.</span></label>
              <button id="participant-submit-button" type="submit" class="w-full rounded-2xl bg-cyan-700 px-6 py-4 text-sm font-black uppercase tracking-widest text-white transition-all hover:bg-cyan-800">Kirim Karya untuk Ditinjau</button>
            </form>
          </>
        )}
      </div>
    </Layout>
  );
}

function renderParticipantWorkForm(c: any, work: any = null, activities: any[] = [], selectedActivityId: number | null = null, user: any = null) {
  const inputClass = "peer w-full rounded-2xl border border-white/10 bg-slate-950/50 px-5 pt-7 pb-3 text-lg text-white placeholder-transparent transition-all focus:border-cyan-500 focus:outline-none";
  const labelClass = "absolute left-5 top-5 pointer-events-none text-xs font-bold uppercase tracking-widest text-slate-500 transition-all peer-placeholder-shown:top-5 peer-placeholder-shown:text-base peer-placeholder-shown:font-medium peer-focus:top-2 peer-focus:text-[10px] peer-focus:font-bold peer-focus:text-cyan-500 peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:font-bold peer-[:not(:placeholder-shown)]:text-cyan-500";
  const activityValue = work?.activityId || selectedActivityId || '';

  return c.html(
    <AdminLayout title={`${work ? 'Edit' : 'New'} Participant Work | Admin`} user={user} currentPath="/admin/activities" showNavigation={false}>
      <div class="mx-auto max-w-4xl px-6 pt-10 pb-32">
        <a href="/admin/works" class="text-xs font-black uppercase tracking-widest text-cyan-400 hover:text-white">← Participant Works</a>
        <h1 class="mt-8 mb-12 text-4xl font-black italic tracking-tight">{work ? 'EDIT' : 'NEW'} <span class="text-cyan-400">PARTICIPANT WORK</span></h1>
        <form action="/admin/works/save" method="post" enctype="multipart/form-data" class="space-y-8 rounded-[2.5rem] border border-white/10 bg-white/5 p-8 backdrop-blur-xl">
          {work && <input type="hidden" name="id" value={work.id} />}
          <div class="relative"><select name="activityId" required class={`${inputClass} appearance-none`}><option value="">Pilih aktivitas workshop</option>{activities.map(activity => <option value={activity.id} selected={String(activity.id) === String(activityValue)}>{activity.title}</option>)}</select><label class={labelClass}>Activity</label></div>
          <div class="grid gap-6 md:grid-cols-2"><div class="relative"><input type="text" name="title" value={work?.title || ''} placeholder=" " required class={inputClass} /><label class={labelClass}>Work Title</label></div><div class="relative"><input type="text" name="participantName" value={work?.participantName || ''} placeholder=" " required class={inputClass} /><label class={labelClass}>Participant Name</label></div></div>
          <div class="grid gap-6 md:grid-cols-2"><div class="relative"><input type="text" name="institution" value={work?.institution || ''} placeholder=" " class={inputClass} /><label class={labelClass}>Institution (optional)</label></div><div class="relative"><input type="text" name="tags" value={work?.tags || ''} placeholder=" " class={inputClass} /><label class={labelClass}>Tags (comma separated)</label></div></div>
          <div class="relative"><textarea name="description" placeholder=" " class={`${inputClass} min-h-[150px] leading-relaxed`}>{work?.description || ''}</textarea><label class={labelClass}>Description</label></div>
          <div class="grid gap-6 md:grid-cols-2"><div class="relative"><input type="url" name="workUrl" value={work?.workUrl || ''} placeholder=" " class={inputClass} /><label class={labelClass}>Work URL (optional)</label></div><div class="relative"><input type="number" name="sortOrder" value={work?.sortOrder || 0} placeholder=" " min="0" class={inputClass} /><label class={labelClass}>Display Order</label></div></div>
          <div class="grid gap-6 md:grid-cols-2"><div class="relative"><input type="url" name="previewImage" value={work?.previewImage || ''} placeholder=" " class={inputClass} /><label class={labelClass}>Preview Image URL</label></div><div class="space-y-2"><label class="pl-1 text-[10px] font-black uppercase tracking-widest text-slate-500">Or Upload Preview to RustFS <span class="text-cyan-400">(otomatis WebP)</span></label><input type="file" name="previewImageFile" accept="image/jpeg,image/png,image/webp" class="w-full rounded-2xl border border-white/10 bg-slate-950/50 px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white" /><p class="text-xs leading-relaxed text-slate-500">JPG, PNG, atau WebP; maksimal 10 MB.</p></div></div>
          <div class="flex flex-col gap-5 rounded-2xl border border-white/5 bg-slate-950/40 p-5"><label class="flex items-center gap-3 text-sm font-bold text-slate-300"><input type="checkbox" name="consent" checked={Boolean(work?.consent)} class="h-5 w-5 accent-cyan-600" /> Peserta menyetujui karya ditampilkan secara publik</label><div class="flex flex-col gap-4 sm:flex-row sm:items-center"><select name="status" class="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300"><option value="draft" selected={work?.status !== 'published'}>Draft / Pending review</option><option value="published" selected={work?.status === 'published'}>Published</option></select><p class="text-xs leading-relaxed text-slate-500">Karya hanya tampil publik jika status Published dan consent aktif.</p></div></div>
          <div class="flex gap-4 pt-4"><button type="submit" class="rounded-xl bg-cyan-700 px-8 py-4 font-black uppercase tracking-widest text-white transition-all hover:bg-cyan-800">Save Work</button><a href="/admin/works" class="rounded-xl border border-white/10 px-8 py-4 font-black text-slate-400 transition-colors hover:text-white">Cancel</a></div>
        </form>
      </div>
    </AdminLayout>
  );
}

function renderActivityForm(c: any, activity: any = null, media: any[] = [], links: any[] = [], user: any = null) {
  const inputClass = "peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-cyan-500 transition-all text-white text-lg placeholder-transparent";
  const labelClass = "absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-slate-500 peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-cyan-500 peer-focus:uppercase peer-focus:font-bold peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:text-cyan-500 peer-[:not(:placeholder-shown)]:uppercase peer-[:not(:placeholder-shown)]:font-bold";
  const galleryUrls = media.map(item => item.url).join('\n');
  const additionalLinks = links.filter(link => link.label && link.url);

  return c.html(
    <AdminLayout title={(activity ? 'Edit' : 'New') + ' Activity | Admin'} user={user} currentPath="/admin/activities" showNavigation={false}>
      <div class="max-w-5xl mx-auto px-6 pt-10 pb-32">
        <a href="/admin" class="text-xs font-black text-cyan-400 uppercase tracking-widest hover:text-white">← Admin Dashboard</a>
        <h1 class="text-4xl font-black mt-8 mb-12 italic tracking-tight">{activity ? 'EDIT' : 'NEW'} <span class="text-cyan-400">JEJAK</span></h1>
        <form action="/admin/activities/save" method="post" enctype="multipart/form-data" class="space-y-8 bg-white/5 p-8 rounded-[2.5rem] border border-white/10 backdrop-blur-xl">
          {activity && <input type="hidden" name="id" value={activity.id} />}
          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative"><input type="text" name="title" id="a-title" value={activity?.title || ''} placeholder=" " required class={inputClass} /><label for="a-title" class={labelClass}>Activity Title</label></div>
            <div class="relative"><input type="text" name="slug" id="a-slug" value={activity?.slug || ''} placeholder=" " class={inputClass} /><label for="a-slug" class={labelClass}>Slug (optional)</label></div>
          </div>
          <div class="grid md:grid-cols-3 gap-6">
            <div class="relative"><input type="date" name="eventDate" id="a-date" value={activity?.eventDate || ''} required class={inputClass} /><label for="a-date" class={labelClass}>Event Date</label></div>
            <div class="relative"><input type="date" name="endDate" id="a-end-date" value={activity?.endDate || ''} class={inputClass} /><label for="a-end-date" class={labelClass}>End Date (optional)</label></div>
            <div class="relative"><input type="number" name="year" id="a-year" value={activity?.year || ''} placeholder=" " min="1900" max="2200" class={inputClass} /><label for="a-year" class={labelClass}>Year (optional)</label></div>
          </div>
          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative"><input type="text" name="role" id="a-role" value={activity?.role || ''} placeholder=" " required class={inputClass} /><label for="a-role" class={labelClass}>Role (e.g. Pemateri)</label></div>
            <div class="relative"><input type="text" name="category" id="a-category" value={activity?.category || ''} placeholder=" " required class={inputClass} /><label for="a-category" class={labelClass}>Category (e.g. AI & EdTech)</label></div>
          </div>
          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative"><input type="text" name="location" id="a-location" value={activity?.location || ''} placeholder=" " class={inputClass} /><label for="a-location" class={labelClass}>Location</label></div>
            <div class="relative"><input type="text" name="organizer" id="a-organizer" value={activity?.organizer || ''} placeholder=" " class={inputClass} /><label for="a-organizer" class={labelClass}>Organizer</label></div>
          </div>
          <div class="relative"><textarea name="summary" id="a-summary" placeholder=" " required class={inputClass + ' min-h-[110px] leading-relaxed'}>{activity?.summary || ''}</textarea><label for="a-summary" class={labelClass}>Short Summary</label></div>
          <div class="relative"><textarea name="description" id="a-description" placeholder=" " class={inputClass + ' min-h-[280px] font-mono text-sm leading-relaxed'}>{activity?.description || ''}</textarea><label for="a-description" class={labelClass}>Description (Markdown)</label></div>
          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative"><input type="text" name="coverImage" id="a-cover" value={activity?.coverImage || ''} placeholder=" " class={inputClass} /><label for="a-cover" class={labelClass}>Cover Image URL</label></div>
            <div class="space-y-2"><label class="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Or Upload Cover to RustFS <span class="text-cyan-400">(otomatis WebP)</span></label><input type="file" name="coverImageFile" accept="image/jpeg,image/png,image/webp" class="w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white" /><p class="text-xs leading-relaxed text-slate-500">JPG, PNG, atau WebP; maksimal 10 MB.</p></div>
          </div>
          <div class="grid gap-6 md:grid-cols-2">
            <div class="space-y-2"><label class="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Upload Gallery Photos to RustFS <span class="text-cyan-400">(otomatis WebP)</span></label><input type="file" name="galleryFiles" accept="image/jpeg,image/png,image/webp" multiple class="w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-cyan-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white" /><p class="text-xs leading-relaxed text-slate-500">Pilih beberapa foto sekaligus. JPG, PNG, atau WebP; maksimal 10 MB per file.</p></div>
            <div class="relative"><textarea name="galleryUrls" id="a-gallery" placeholder=" " class={inputClass + ' min-h-[140px] font-mono text-sm leading-relaxed'}>{galleryUrls}</textarea><label for="a-gallery" class={labelClass}>Direct Image URLs (optional)</label><p class="mt-2 text-xs leading-relaxed text-amber-400/80">Gunakan URL file gambar langsung, bukan link album Google Photos.</p></div>
          </div>
          <div class="relative"><input type="url" name="galleryAlbumUrl" id="a-gallery-album" value={activity?.galleryAlbumUrl || ''} placeholder=" " class={inputClass} /><label for="a-gallery-album" class={labelClass}>Google Photos Album URL (optional)</label></div>
          <div class="grid md:grid-cols-3 gap-6">
            <div class="space-y-3"><div class="relative"><input type="url" name="materialUrl" id="a-material" value={activity?.materialUrl || ''} placeholder=" " class={inputClass} /><label for="a-material" class={labelClass}>Material URL</label></div><div><label for="a-material-from" class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-500">Tersedia mulai</label><input type="datetime-local" name="materialAvailableFrom" id="a-material-from" value={formatJakartaDateTime(activity?.materialAvailableFrom)} class="w-full rounded-xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300 focus:border-cyan-500 focus:outline-none" /></div><div><label for="a-material-until" class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-500">Tersedia sampai</label><input type="datetime-local" name="materialAvailableUntil" id="a-material-until" value={formatJakartaDateTime(activity?.materialAvailableUntil)} class="w-full rounded-xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300 focus:border-cyan-500 focus:outline-none" /></div></div>
            <div class="space-y-3"><div class="relative"><input type="url" name="certificateUrl" id="a-certificate" value={activity?.certificateUrl || ''} placeholder=" " class={inputClass} /><label for="a-certificate" class={labelClass}>Certificate URL</label></div><div><label for="a-certificate-from" class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-500">Tersedia mulai</label><input type="datetime-local" name="certificateAvailableFrom" id="a-certificate-from" value={formatJakartaDateTime(activity?.certificateAvailableFrom)} class="w-full rounded-xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300 focus:border-cyan-500 focus:outline-none" /></div><div><label for="a-certificate-until" class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-500">Tersedia sampai</label><input type="datetime-local" name="certificateAvailableUntil" id="a-certificate-until" value={formatJakartaDateTime(activity?.certificateAvailableUntil)} class="w-full rounded-xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300 focus:border-cyan-500 focus:outline-none" /></div></div>
            <div class="space-y-3"><div class="relative"><input type="url" name="publicationUrl" id="a-publication" value={activity?.publicationUrl || ''} placeholder=" " class={inputClass} /><label for="a-publication" class={labelClass}>Publication URL</label></div><div><label for="a-publication-from" class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-500">Tersedia mulai</label><input type="datetime-local" name="publicationAvailableFrom" id="a-publication-from" value={formatJakartaDateTime(activity?.publicationAvailableFrom)} class="w-full rounded-xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300 focus:border-cyan-500 focus:outline-none" /></div><div><label for="a-publication-until" class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-500">Tersedia sampai</label><input type="datetime-local" name="publicationAvailableUntil" id="a-publication-until" value={formatJakartaDateTime(activity?.publicationAvailableUntil)} class="w-full rounded-xl border border-white/10 bg-slate-950/50 px-4 py-3 text-sm text-slate-300 focus:border-cyan-500 focus:outline-none" /></div></div>
          </div>
          <p class="-mt-3 text-xs leading-relaxed text-slate-500">Jadwal bersifat opsional. Waktu mengikuti WIB (Asia/Jakarta); sebelum waktunya tombol akan terkunci dan URL tidak ditampilkan.</p>
          <section class="space-y-5 rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-5 md:p-6">
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><h2 class="text-sm font-black uppercase tracking-widest text-cyan-300">Additional Links</h2><p class="mt-2 max-w-2xl text-xs leading-relaxed text-slate-500">Tambahkan tautan opsional lain. Setiap baris akan tampil sebagai satu tombol di bawah deskripsi aktivitas.</p></div><button type="button" onclick="addActivityLink()" class="shrink-0 rounded-xl bg-cyan-700 px-4 py-3 text-xs font-black uppercase tracking-widest text-white transition-all hover:bg-cyan-800">+ Tambah tautan</button></div>
            <div id="activity-links-list" class="space-y-3">{additionalLinks.map(link => <div data-activity-link-row class="grid items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/40 p-3 md:grid-cols-[1fr_1.5fr_auto]"><input type="text" name="activityLinkLabel" value={link.label} placeholder="Nama tombol, contoh: Berita Kegiatan" aria-label="Nama tombol" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none" /><input type="url" name="activityLinkUrl" value={link.url} placeholder="https://contoh.com" aria-label="URL tautan" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none" /><div class="grid gap-2 sm:grid-cols-2 md:col-span-2"><div><label class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-600">Mulai</label><input type="datetime-local" name="activityLinkAvailableFrom" value={formatJakartaDateTime(link.availableFrom)} aria-label="Waktu mulai tautan" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none" /></div><div><label class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-600">Sampai</label><input type="datetime-local" name="activityLinkAvailableUntil" value={formatJakartaDateTime(link.availableUntil)} aria-label="Waktu selesai tautan" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none" /></div></div><button type="button" onclick="removeActivityLink(this)" class="rounded-xl border border-white/10 px-4 py-3 text-xs font-bold text-slate-500 transition-colors hover:border-red-500/30 hover:text-red-400 md:col-start-3 md:row-start-1">Hapus</button></div>)}</div>
            <p id="activity-links-empty" class={`${additionalLinks.length > 0 ? 'hidden ' : ''}text-xs italic text-slate-600`}>Belum ada tautan tambahan.</p>
            <template id="activity-link-template"><div data-activity-link-row class="grid items-center gap-3 rounded-2xl border border-white/10 bg-slate-950/40 p-3 md:grid-cols-[1fr_1.5fr_auto]"><input type="text" name="activityLinkLabel" placeholder="Nama tombol, contoh: Berita Kegiatan" aria-label="Nama tombol" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none" /><input type="url" name="activityLinkUrl" placeholder="https://contoh.com" aria-label="URL tautan" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none" /><div class="grid gap-2 sm:grid-cols-2 md:col-span-2"><div><label class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-600">Mulai</label><input type="datetime-local" name="activityLinkAvailableFrom" aria-label="Waktu mulai tautan" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none" /></div><div><label class="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-600">Sampai</label><input type="datetime-local" name="activityLinkAvailableUntil" aria-label="Waktu selesai tautan" class="w-full rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none" /></div></div><button type="button" onclick="removeActivityLink(this)" class="rounded-xl border border-white/10 px-4 py-3 text-xs font-bold text-slate-500 transition-colors hover:border-red-500/30 hover:text-red-400 md:col-start-3 md:row-start-1">Hapus</button></div></template>
            <script dangerouslySetInnerHTML={{ __html: `
              window.addActivityLink = () => {
                const list = document.getElementById('activity-links-list');
                const template = document.getElementById('activity-link-template');
                if (!list || !template) return;
                list.appendChild(template.content.cloneNode(true));
                document.getElementById('activity-links-empty')?.classList.add('hidden');
              };
              window.removeActivityLink = (button) => {
                button.closest('[data-activity-link-row]')?.remove();
                const list = document.getElementById('activity-links-list');
                if (!list?.querySelector('[data-activity-link-row]')) document.getElementById('activity-links-empty')?.classList.remove('hidden');
              };
            `}} />
          </section>
          <div class="flex flex-col sm:flex-row gap-6 sm:items-center p-5 bg-slate-950/40 border border-white/5 rounded-2xl">
            <label class="flex items-center gap-3 text-sm font-bold text-slate-300"><input type="checkbox" name="featuredOnCv" checked={Boolean(activity?.featuredOnCv)} class="w-5 h-5 accent-cyan-600" /> Feature on CV / selected highlights</label>
            <select name="status" class="bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-slate-300"><option value="draft" selected={activity?.status !== 'published'}>Draft</option><option value="published" selected={activity?.status === 'published'}>Published</option></select>
          </div>
          <div class="flex gap-4 pt-4"><button type="submit" class="px-10 py-4 bg-cyan-700 hover:bg-cyan-800 text-white font-black rounded-xl transition-all uppercase tracking-widest">Save Activity</button><a href="/admin" class="px-10 py-4 border border-white/10 rounded-xl font-black text-slate-400 hover:text-white transition-all">Cancel</a></div>
        </form>
      </div>
    </AdminLayout>
  );
}

function renderProjectForm(c: any, project: any = null, user: any = null) {
  const inputClass = "peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent";
  const labelClass = "absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-slate-500 peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-placeholder-shown:lowercase peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500 peer-focus:uppercase peer-focus:font-bold peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:text-red-500 peer-[:not(:placeholder-shown)]:uppercase peer-[:not(:placeholder-shown)]:font-bold";

  return c.html(
    <AdminLayout title={`${project ? 'Edit' : 'New'} Project | Admin`} user={user} currentPath="/admin/projects" showNavigation={false}>
      <div class="max-w-4xl mx-auto px-6 pt-10 pb-32">

        <h1 class="text-4xl font-black mb-12 italic tracking-tight">{project ? 'EDIT' : 'NEW'} <span class="text-red-700">PROJECT</span></h1>
        <form id="project-form" action="/admin/projects/save" method="post" enctype="multipart/form-data" class="space-y-8 bg-white/5 p-8 rounded-[2.5rem] border border-white/10 backdrop-blur-xl">
          {project && <input type="hidden" name="id" value={project.id} />}
          
          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative">
              <input type="text" name="title" id="p-title" value={project?.title || ''} placeholder=" " required class={inputClass} />
              <label for="p-title" class={labelClass}>Project Title</label>
            </div>
            <div class="relative">
              <input type="text" name="slug" id="p-slug" value={project?.slug || ''} placeholder=" " required class={inputClass} />
              <label for="p-slug" class={labelClass}>Slug</label>
            </div>
          </div>

          <div class="relative">
            <textarea name="description" id="desc" rows={2} placeholder=" " required class={`${inputClass} leading-relaxed min-h-[80px]`}>{project?.description || ''}</textarea>
            <label for="desc" class={labelClass}>Short Description</label>
          </div>

          <div class="relative">
            <textarea name="content" id="p-content-input" placeholder=" " required class={`${inputClass} leading-relaxed min-h-[300px] font-mono text-sm`}>{project?.content || ''}</textarea>
            <label for="p-content-input" class={labelClass}>Case Study Markdown</label>
          </div>

          <div class="relative">
            <input type="text" name="techStack" id="tech" value={project?.techStack || ''} placeholder=" " class={inputClass} />
            <label for="tech" class={labelClass}>Tech Stack (comma separated)</label>
          </div>
          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative">
              <input type="text" name="image" id="p-image" value={project?.image || ''} placeholder=" " class={inputClass} />
              <label for="p-image" class={labelClass}>Thumbnail Image URL</label>
            </div>
            <div class="relative space-y-2 mt-4 md:mt-0">
              <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Atau Upload Thumbnail Baru <span class="text-cyan-400">(otomatis WebP)</span></label>
              <input type="file" name="projectImageFile" accept="image/jpeg,image/png,image/webp" class="w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-red-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white hover:file:bg-red-800 cursor-pointer transition-all" />
            </div>
          </div>

          <div class="grid md:grid-cols-2 gap-6">
            <div class="relative">
              <input type="url" name="link" id="link" value={project?.link || ''} placeholder=" " class={inputClass} />
              <label for="link" class={labelClass}>Live Link</label>
            </div>
            <div class="relative">
              <input type="url" name="github" id="github" value={project?.github || ''} placeholder=" " class={inputClass} />
              <label for="github" class={labelClass}>GitHub Link</label>
            </div>
          </div>

          <div class="flex gap-4 pt-4">
            <button id="p-submit-btn" type="submit" class="px-10 py-4 bg-red-700 text-white font-black rounded-xl btn-shadow hover:scale-[1.02] disabled:opacity-50 disabled:scale-100 transition-all tracking-widest uppercase relative overflow-hidden group">
              <span id="p-btn-text" class="transition-opacity">SAVE PROJECT</span>
              <div id="p-btn-loader" class="absolute inset-0 flex items-center justify-center bg-red-900 opacity-0 pointer-events-none transition-opacity">
                <span id="p-loader-msg" class="text-sm font-black">UPLOADING...</span>
              </div>
            </button>
            <a href="/admin" class="px-10 py-4 border border-white/10 rounded-xl font-black text-slate-400 hover:text-white transition-all text-center flex items-center justify-center">CANCEL</a>
          </div>
        </form>

        <script dangerouslySetInnerHTML={{ __html: `
          document.getElementById('project-form').onsubmit = async function(e) {
            e.preventDefault();
            
            const form = e.target;
            const fileInput = form.querySelector('input[type="file"]');
            const btn = document.getElementById('p-submit-btn');
            const btnText = document.getElementById('p-btn-text');
            const btnLoader = document.getElementById('p-btn-loader');
            const loaderMsg = document.getElementById('p-loader-msg');
            
            if (fileInput.files.length > 0) {
              loaderMsg.innerHTML = '<span class="animate-pulse">UPLOADING TO RUSTFS...</span>';
            } else {
              loaderMsg.innerHTML = '<span class="animate-pulse">SAVING...</span>';
            }
            
            btn.disabled = true;
            btnText.style.opacity = '0';
            btnLoader.style.opacity = '1';
            
            try {
              const formData = new FormData(form);
              const res = await fetch(form.action, {
                method: 'POST',
                body: formData
              });
              
              if (res.ok) {
                loaderMsg.innerHTML = '<span class="text-green-400">SUCCESS!</span>';
                setTimeout(() => window.location.href = '/admin', 800);
              } else {
                const errorText = await res.text();
                alert('Upload Gagal: ' + errorText);
                btn.disabled = false;
                btnText.style.opacity = '1';
                btnLoader.style.opacity = '0';
              }
            } catch (err) {
              alert('Network Error: ' + err.message);
              btn.disabled = false;
              btnText.style.opacity = '1';
              btnLoader.style.opacity = '0';
            }
          };
        `}} />
      </div>
    </AdminLayout>
  );
}

function renderSettingsForm(c: any, settings: any, user: any = null) {
  const inputClass = "peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent";
  const labelClass = "absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-slate-500 peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-placeholder-shown:lowercase peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500 peer-focus:uppercase peer-focus:font-bold peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:text-red-500 peer-[:not(:placeholder-shown)]:uppercase peer-[:not(:placeholder-shown)]:font-bold";

  return c.html(
    <AdminLayout title="Home Settings | Admin" user={user} currentPath="/admin/settings">
      <div class="max-w-4xl mx-auto px-6 py-20">

        <h1 class="text-4xl font-black mb-12 italic tracking-tight">HOME <span class="text-red-700">SETTINGS</span></h1>
        <form action="/admin/settings/save" method="post" class="space-y-8 bg-white/5 p-8 rounded-[2.5rem] border border-white/10 backdrop-blur-xl">
          
          <div class="space-y-4">
            <h2 class="text-sm font-black text-slate-500 uppercase tracking-widest ml-1">Hero Section</h2>
            <div class="relative">
              <input type="text" name="hero_title" id="hero_title" value={settings.hero_title || ''} placeholder=" " class={inputClass} />
              <label for="hero_title" class={labelClass}>Hero Title (HTML allowed)</label>
            </div>
            <div class="relative">
              <textarea name="hero_desc" id="hero_desc" rows={3} placeholder=" " class={`${inputClass} leading-relaxed min-h-[100px]`}>{settings.hero_desc || ''}</textarea>
              <label for="hero_desc" class={labelClass}>Hero Description</label>
            </div>
          </div>

          <div class="space-y-4">
            <h2 class="text-sm font-black text-slate-500 uppercase tracking-widest ml-1">Philosophies Section</h2>
            <div class="relative">
              <input type="text" name="phil_title" id="phil_title" value={settings.phil_title || ''} placeholder=" " class={inputClass} />
              <label for="phil_title" class={labelClass}>Philosophy Title (HTML allowed)</label>
            </div>
            <div class="relative">
              <textarea name="phil_desc" id="phil_desc" rows={3} placeholder=" " class={`${inputClass} leading-relaxed min-h-[100px]`}>{settings.phil_desc || ''}</textarea>
              <label for="phil_desc" class={labelClass}>Philosophy Description</label>
            </div>
          </div>

          <div class="flex gap-4 pt-4">
            <button type="submit" class="px-10 py-4 bg-red-700 text-white font-black rounded-xl btn-shadow hover:scale-[1.02] active:scale-[0.98] transition-all tracking-widest uppercase">SAVE SETTINGS</button>
            <a href="/admin" class="px-10 py-4 border border-white/10 rounded-xl font-black text-slate-400 hover:text-white transition-all text-center flex items-center justify-center">CANCEL</a>
          </div>
        </form>
      </div>
      </AdminLayout>
  );
}

// --- SETTINGS & MILESTONES ---
app.post('/admin/settings/cv', async (c) => {
  const body = await c.req.parseBody();
  const cvUrl = body.cv_url as string;
  await db.insert(settingsTable)
    .values({ key: 'cv_url', value: cvUrl })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: cvUrl } });
  return c.redirect('/admin');
});

app.post('/admin/milestones/save', async (c) => {
  const body = await c.req.parseBody();
  await db.insert(milestonesTable).values({
    year: body.year as string,
    title: body.title as string,
    description: body.description as string,
    type: body.type as string,
  });
  return c.redirect('/admin');
});

app.post('/admin/milestones/delete/:id', async (c) => {
  await db.delete(milestonesTable).where(eq(milestonesTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin');
});

// --- MODERATION & INBOX ROUTES ---
app.post('/admin/contacts/read/:id', async (c) => {
  await db.update(contactTable).set({ isRead: 1 }).where(eq(contactTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin/inbox');
});

app.post('/admin/contacts/delete/:id', async (c) => {
  await db.delete(contactTable).where(eq(contactTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin/inbox');
});

app.post('/admin/comments/delete/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  const allComments = await db.select({ id: commentTable.id, parentId: commentTable.parentId }).from(commentTable);
  const idsToDelete = new Set([id]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const comment of allComments) {
      if (comment.parentId && idsToDelete.has(comment.parentId) && !idsToDelete.has(comment.id)) {
        idsToDelete.add(comment.id);
        expanded = true;
      }
    }
  }
  await db.delete(commentTable).where(inArray(commentTable.id, Array.from(idsToDelete)));
  return c.redirect('/admin/inbox#comments');
});

// Profile saving moved to main profiling section above



export { app };

export default {
  port: Number(process.env.PORT || 4128),
  hostname: '0.0.0.0',
  fetch: app.fetch,
};
