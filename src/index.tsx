/** @jsx jsx */
import { jsx } from 'hono/jsx';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { setCookie, getCookie } from 'hono/cookie';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { db } from './db';
import { projects as projectTable, blogPosts, skills as skillTable, experience as expTable, settings as settingsTable, contacts as contactTable, comments as commentTable, reactions as reactionTable, subscriptions as subTable, pageViews as viewTable, milestones as milestonesTable, profiles as profileTable } from './db/schema';
import { eq, desc, or, like, and, sql } from 'drizzle-orm';
import { Layout } from './components/Layout';
import { marked } from 'marked';
import { z as zod } from 'zod';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

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
} catch (error) {
  console.error('Schema compatibility check failed:', error);
}

// --- MIDDLEWARE ---
app.use('*', async (c, next) => {
  const path = c.req.path;
  // Skip analytics for admin and static files
  if (!path.startsWith('/admin') && !path.startsWith('/static') && !path.startsWith('/auth')) {
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
  if (!query) return c.json({ projects: [], blog: [] });

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

  return c.json({ projects, blog });
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
  
  const heroTitle = settings.hero_title || "Building <span class=\"text-red-700 italic\">Impact</span><br />Through Code";
  const heroDesc = settings.hero_desc || "Hi, I'm Ferilee. I craft high-performance digital experiences that bridge the gap between complex technology and human-centric design.";
  const philTitle = settings.phil_title || "Creative<br />Philosophies";
  const philDesc = settings.phil_desc || "Sharing deep dives into fullstack development, architecture, and my journey in the tech industry.";

  const projects = await db.select().from(projectTable).limit(3);
  const skills = await db.select().from(skillTable);
  const experience = await db.select().from(expTable);
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
                <a href="/projects" class="px-10 py-4 bg-red-700 hover:bg-red-800 text-white font-bold rounded-xl btn-shadow transition-all hover:scale-105 active:scale-95 text-center">View Work</a>
                <a href={cvUrl} target="_blank" class="px-10 py-4 border border-white/10 hover:bg-white/5 text-white font-bold rounded-xl transition-all hover:scale-105 active:scale-95 text-center flex items-center justify-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Resume
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
                <a href="/blog" class="px-10 py-4 bg-red-900/40 hover:bg-red-900/60 text-white font-bold rounded-xl border border-red-700/30 transition-all hover:scale-105 active:scale-95 text-center">Read Blog</a>
              </div>
            </div>
          </div>
        </section>
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
    <Layout title="Ferilee | Projects" user={user} needsProfiling={c.var.needsProfiling} currentPath="/projects">
      <div class="max-w-6xl mx-auto px-6 py-20">

        <header class="mb-12 text-center">
          <h1 class="text-6xl font-black mb-6 tracking-tight">Crafted <span class="text-red-700">Solutions</span></h1>
          <p class="text-slate-400 max-w-xl mx-auto">Explore my technical journey through these selected works, from full-stack applications to architectural deep-dives.</p>
        </header>

        {/* Tech Filter */}
        <div class="flex flex-wrap justify-center gap-3 mb-16">
          <button onclick="filterProjects('all')" class="tech-filter-btn active px-6 py-2 rounded-full border border-white/10 text-xs font-bold uppercase tracking-widest bg-white/5 hover:bg-white/10 transition-all">All</button>
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
                  <a href={`/projects/${project.slug || project.id}`} class="inline-flex items-center gap-2 text-sm font-bold text-red-500 hover:text-red-400 transition-colors uppercase tracking-widest">Case Study
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
              if (btn.innerText.toLowerCase() === tech.toLowerCase() || (tech === 'all' && btn.innerText.toLowerCase() === 'all')) {
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

  const contentHtml = await marked.parse(project.content || 'Case study content coming soon...');
  const ogImage = project.image || `/api/og?title=${encodeURIComponent(project.title)}&category=Case Study`;

  return c.html(
    <Layout title={`${project.title} | Case Study`} user={user} ogImage={ogImage} needsProfiling={c.var.needsProfiling} currentPath="/projects">
      <div class="max-w-4xl mx-auto px-6 py-20">
        <header class="mb-16">
          <a href="/projects" class="text-xs font-bold text-slate-500 uppercase tracking-widest hover:text-white transition-all mb-8 block">← Back to Projects</a>
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
              <h3 class="text-sm font-black text-slate-500 uppercase tracking-widest mb-6">Quick Links</h3>
              <div class="space-y-4">
                {project.link && (
                  <a href={project.link} target="_blank" class="flex items-center justify-between w-full px-6 py-4 bg-red-700 hover:bg-red-800 text-white font-bold rounded-xl transition-all">
                    <span>Live Preview</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                )}
                {project.github && (
                  <a href={project.github} target="_blank" class="flex items-center justify-between w-full px-6 py-4 bg-white/5 border border-white/10 hover:bg-white/10 text-white font-bold rounded-xl transition-all">
                    <span>Repository</span>
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
              <h2 class="text-3xl font-black tracking-tight">Interactive <span class="text-red-700">Preview</span></h2>
              <span class="text-[10px] font-black text-slate-500 uppercase tracking-widest italic flex items-center gap-2">
                <div class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div> Live Environment
              </span>
            </div>
            <div class="bg-white/5 border border-white/10 rounded-[2.5rem] overflow-hidden aspect-video relative group">
              <div class="absolute inset-0 bg-slate-900 flex items-center justify-center z-0">
                <div class="text-slate-700 font-bold italic">Loading Preview...</div>
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
          <h1 class="text-5xl font-black mb-4">Insights & Thoughts</h1>
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
                    {Math.ceil((post.content?.split(/\s+/).length || 0) / 200)} min read
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
            <h2 class="text-3xl font-black mb-2 tracking-tight">YOU'RE <span class="text-green-500">IN!</span></h2>
            <p class="text-slate-400 font-bold uppercase tracking-widest text-xs">Successfully subscribed! Thank you.</p>
          </div>
        ) : (
          <div class="mt-32 p-6 md:p-12 bg-white/5 border border-white/10 rounded-[3rem] backdrop-blur-xl relative overflow-hidden text-center">
            <div class="absolute -top-24 -left-24 w-64 h-64 bg-cyan-900/10 rounded-full blur-[100px]"></div>
            <h2 class="text-2xl md:text-3xl font-black mb-4 tracking-tight">Stay <span class="text-cyan-400">Updated</span></h2>
            <p class="text-slate-400 mb-8 max-w-md mx-auto">Get notified when I publish new articles about tech, development, and my journey.</p>
            <form action="/subscribe" method="post" class="max-w-md mx-auto flex flex-col sm:flex-row gap-4">
              <input type="email" name="email" placeholder="Your email address" required class="flex-grow bg-slate-950/50 border border-white/10 rounded-xl px-6 py-4 text-slate-300 focus:outline-none focus:border-cyan-500 transition-all" />
              <button type="submit" class="px-8 py-4 bg-cyan-600 hover:bg-cyan-700 text-white font-black rounded-xl transition-all hover:scale-105 active:scale-95 whitespace-nowrap">Subscribe</button>
            </form>
          </div>
        )}
      </div>
    </Layout>
  );
});

app.get('/timeline', async (c) => {
  const user = c.var.user;
  const milestones = await db.select().from(milestonesTable).orderBy(desc(milestonesTable.year));

  return c.html(
    <Layout title="Ferilee | Timeline" user={user} needsProfiling={c.var.needsProfiling} currentPath="/timeline">
      <div class="max-w-4xl mx-auto px-6 py-32">
        <header class="text-center mb-24">
          <h1 class="text-6xl font-black mb-6 tracking-tight italic">MY <span class="text-red-700">JOURNEY</span></h1>
          <p class="text-slate-400 max-w-md mx-auto">A visual timeline of my career milestones, academic achievements, and personal growth.</p>
        </header>

        <div class="relative border-l-2 border-white/5 ml-4 md:ml-0 md:left-1/2">
          {milestones.map((item, idx) => (
            <div class={`mb-20 relative ${idx % 2 === 0 ? 'md:pr-12 md:text-right md:left-[-100%]' : 'md:pl-12 md:left-0'}`}>
              <div class={`absolute top-0 w-8 h-8 rounded-full border-4 border-slate-950 flex items-center justify-center z-10 ${idx % 2 === 0 ? 'right-[-17px] md:right-[-17px]' : 'left-[-17px] md:left-[-17px]'} ${item.type === 'work' ? 'bg-blue-500' : item.type === 'education' ? 'bg-green-500' : 'bg-red-700'}`}>
                {item.type === 'work' ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="text-white"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                ) : (
                  <div class="w-2 h-2 bg-white rounded-full"></div>
                )}
              </div>
              <div class={`w-full md:w-[450px] bg-white/5 border border-white/10 p-8 rounded-3xl backdrop-blur-xl hover:border-red-500/30 transition-all ${idx % 2 === 0 ? 'md:ml-auto' : ''}`}>
                <span class="text-xs font-black text-red-500 uppercase tracking-widest mb-2 block">{item.year}</span>
                <h3 class="text-2xl font-bold mb-4">{item.title}</h3>
                <p class="text-slate-400 text-sm leading-relaxed">{item.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
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
                {readingTime} min read
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
              <span class="text-xs font-black text-slate-500 uppercase tracking-widest mr-2">Reactions</span>
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
                      title={!user ? "Login to react" : ""}
                    >
                      <span>{item.emoji}</span>
                      <span class="text-xs font-bold">{reactionCounts[item.type as keyof typeof reactionCounts] || 0}</span>
                    </button>
                  </form>
                ))}
              </div>
              {!user && <p class="text-[10px] font-bold text-slate-600 uppercase tracking-widest italic ml-auto">Log in to react</p>}
            </div>

            {/* Social Share Section */}
            <div class="flex items-center gap-4 pt-4">
              <span class="text-xs font-black text-slate-500 uppercase tracking-widest mr-2">Share this post</span>
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
                <button onclick={`navigator.clipboard.writeText(${JSON.stringify(postUrl)}); alert('Link copied for Instagram!')`} class="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center hover:bg-pink-600/20 hover:border-pink-600/50 transition-all text-slate-400 hover:text-pink-500" title="Copy Link for Instagram">
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
            <h3 class="text-2xl font-black italic mb-8 tracking-tight">COMMENTS <span class="text-red-500">SECTION</span> ({allComments.length})</h3>
            
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
                    <span>Replying to <span id="reply-name"></span></span>
                    <button onclick="cancelReply()" class="text-slate-500 hover:text-white underline">Cancel</button>
                  </div>
                </div>
                <form action={`/blog/${post.id}/comment`} method="post" class="space-y-6">
                  <input type="hidden" name="parentId" id="parent-id-input" value="" />
                  <textarea name="content" id="comment-textarea" required class="w-full bg-slate-950/50 border border-white/10 rounded-2xl p-6 text-slate-300 focus:outline-none focus:border-red-500 transition-all mb-4 min-h-[120px]" placeholder="Write your thoughts..."></textarea>
                  <button type="submit" class="px-8 py-3 bg-red-700 hover:bg-red-800 text-white font-bold rounded-xl transition-all hover:scale-105 active:scale-95">Post Comment</button>
                </form>
              </div>
            ) : (
              <div class="text-center py-12 bg-white/5 border border-dashed border-white/10 rounded-[2rem] mb-16">
                <p class="text-slate-400 mb-6">Want to join the discussion?</p>
                <a href="/admin/login" class="px-10 py-4 bg-white text-black font-black rounded-xl hover:bg-slate-200 transition-all tracking-widest uppercase text-sm">Login to Comment</a>
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
                        <button onclick={`setReply(${comment.id}, ${JSON.stringify(comment.name)})`} class="text-[10px] font-black text-cyan-400 uppercase tracking-widest hover:text-white transition-all">Reply</button>
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
              {allComments.length === 0 && <p class="text-center text-slate-600 font-bold italic py-8">Be the first to comment!</p>}
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
    <Layout title="Contact | Ferilee" user={user}>
      <div class="max-w-4xl mx-auto px-6 py-20">

        <div class="text-center mb-16">
          <h1 class="text-5xl font-black mb-4 tracking-tight">Let's <span class="text-red-700">Connect</span></h1>
          <p class="text-slate-400 text-lg">Have a project in mind or just want to say hi?</p>
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
              <h2 class="text-3xl font-black mb-4 tracking-tight">MESSAGE SENT!</h2>
              <p class="text-slate-400 mb-10">Thank you for reaching out. I'll get back to you as soon as possible.</p>
              <a href="/" class="px-10 py-4 border border-white/10 rounded-xl font-bold hover:bg-white/5 transition-all">Go Home</a>
            </div>
          ) : (
            <form action="/contact/send" method="post" class="space-y-8 relative z-10">
              <div class="grid md:grid-cols-2 gap-6">
                <div class="relative">
                  <input type="text" name="name" id="name" placeholder=" " required class={inputClass} value={user?.name || ''} />
                  <label for="name" class={labelClass}>Your Name</label>
                </div>
                <div class="relative">
                  <input type="email" name="email" id="email" placeholder=" " required class={inputClass} value={user?.email || ''} />
                  <label for="email" class={labelClass}>Email Address</label>
                </div>
              </div>

              
              <div class="relative">
                <input type="text" name="subject" id="subject" placeholder=" " required class={inputClass} />
                <label for="subject" class={labelClass}>Subject</label>
              </div>

              <div class="relative">
                <textarea name="message" id="message" rows={5} placeholder=" " required class={`${inputClass} leading-relaxed min-h-[150px]`}></textarea>
                <label for="message" class={labelClass}>Your Message</label>
              </div>

              <button type="submit" class="w-full py-5 bg-red-700 hover:bg-red-800 text-white font-black rounded-2xl transition-all hover:scale-[1.02] active:scale-[0.98] btn-shadow tracking-widest uppercase">Send Message</button>
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
    adminUpdates.emit('update');
    return c.redirect('/contact?success=1');
  } catch (err: any) {
    console.error('Contact submission error:', err);
    return c.html(
      <Layout title="Error | Ferilee">
        <div class="max-w-4xl mx-auto px-6 py-20 text-center">
          <h1 class="text-3xl font-black mb-4">Oops! Something went wrong.</h1>
          <p class="text-slate-400 mb-8">We couldn't send your message. Please try again later.</p>
          <a href="/contact" class="px-10 py-4 bg-red-700 text-white font-bold rounded-xl">Back to Contact</a>
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
    <Layout title="Admin Login | Ferilee" user={user}>
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
    </Layout>
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



app.get('/admin', async (c) => {
  const user = c.var.user;
  const posts = await db.select().from(blogPosts).orderBy(desc(blogPosts.id));
  const projects = await db.select().from(projectTable).orderBy(desc(projectTable.id));
  const messages = await db.select().from(contactTable).orderBy(desc(contactTable.id));
  const unreadCount = messages.filter(m => !m.isRead).length;

  // Analytics Data
  const totalViews = await db.select({ sum: sql<number>`sum(${viewTable.count})` }).from(viewTable);
  const recentComments = await db.select().from(commentTable).where(sql`${commentTable.createdAt} > date('now', '-7 days')`);
  const totalSubs = await db.select().from(subTable);

  return c.html(
    <Layout title="Admin Dashboard | Ferilee" notificationCount={unreadCount} user={user}>
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

        <div class="grid lg:grid-cols-2 gap-12 mb-12">
          {/* Blog Posts */}
          <div class="bg-white/5 border border-white/10 rounded-[2.5rem] p-6 sm:p-8 backdrop-blur-xl">
            <h2 class="text-xl sm:text-2xl font-black italic mb-8">BLOG <span class="text-red-700">POSTS</span></h2>
            <div class="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {posts.map(post => (
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center p-5 bg-slate-950/50 border border-white/5 rounded-2xl gap-4 sm:gap-0">
                  <div>
                    <p class="font-bold text-sm">{post.title}</p>
                    <p class="text-[10px] text-slate-500 uppercase">{post.status}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <a href={`/admin/blog/edit/${post.id}`} class="p-2 bg-white/5 border border-white/10 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all" title="Edit Post">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </a>
                    <form action={`/admin/blog/delete/${post.id}`} method="post" onsubmit="return confirm('Delete this post?')">
                      <button type="submit" class="p-2 bg-white/5 border border-white/10 rounded-lg text-slate-700 hover:text-red-500 hover:bg-red-500/10 transition-all" title="Delete Post">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                      </button>
                    </form>
                  </div>
                </div>
              ))}
              {posts.length === 0 && <p class="text-slate-500 font-bold italic">No posts yet</p>}
            </div>
          </div>

          {/* Portfolio Projects */}
          <div class="bg-white/5 border border-white/10 rounded-[2.5rem] p-6 sm:p-8 backdrop-blur-xl">
            <h2 class="text-xl sm:text-2xl font-black italic mb-8">PORTFOLIO <span class="text-red-700">PROJECTS</span></h2>
            <div class="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
              {projects.map(project => (
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center p-5 bg-slate-950/50 border border-white/5 rounded-2xl gap-4 sm:gap-0">
                  <p class="font-bold text-sm truncate max-w-full sm:max-w-[200px]">{project.title}</p>
                  <div class="flex items-center gap-2">
                    <a href={`/admin/projects/edit/${project.id}`} class="p-2 bg-white/5 border border-white/10 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all" title="Edit Project">
                      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                    </a>
                    <form action={`/admin/projects/delete/${project.id}`} method="post">
                      <button type="submit" class="p-2 bg-white/5 border border-white/10 rounded-lg text-slate-700 hover:text-red-500 hover:bg-red-500/10 transition-all" title="Delete Project">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                      </button>
                    </form>
                  </div>
                </div>
              ))}
              {projects.length === 0 && <p class="text-slate-500 font-bold italic">No projects yet</p>}
            </div>
          </div>
        </div>



        {/* MODERATION & INBOX */}
        <div class="grid lg:grid-cols-2 gap-12 mb-12">
          {/* Inbox Messages */}
          <div class="bg-white/5 border border-white/10 rounded-[2.5rem] p-6 sm:p-8 backdrop-blur-xl overflow-hidden">
            <h2 class="text-xl sm:text-2xl font-black italic mb-8">INBOX <span class="text-red-700">MESSAGES</span></h2>
            <div class="space-y-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
              {messages.map(msg => (
                <div class={`bg-slate-950/40 border ${!msg.isRead ? 'border-red-500/30 ring-1 ring-red-500/20' : 'border-white/5'} rounded-2xl p-4 transition-all relative group`}>
                  <div class="flex flex-col sm:flex-row justify-between items-start gap-4">
                    <div class="flex-grow min-w-0 w-full sm:w-auto">
                      <div class="flex items-center gap-2 mb-1">
                        {!msg.isRead && <div class="w-1.5 h-1.5 bg-red-500 rounded-full"></div>}
                        <span class="text-[10px] font-black text-red-500 uppercase tracking-widest truncate">{msg.subject}</span>
                      </div>
                      <h3 class="font-bold text-sm text-white truncate">{msg.name}</h3>
                      <p class="text-[10px] text-slate-500 truncate mb-3">{msg.email}</p>
                    </div>
                    <div class="flex gap-1">
                      {!msg.isRead && (
                        <form action={`/admin/contacts/read/${msg.id}`} method="post">
                          <button type="submit" class="p-1.5 text-slate-500 hover:text-green-500 transition-colors" title="Mark as Read">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                          </button>
                        </form>
                      )}
                      <form action={`/admin/contacts/delete/${msg.id}`} method="post">
                        <button type="submit" class="p-1.5 text-slate-700 hover:text-red-500 transition-colors">
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                        </button>
                      </form>
                    </div>
                  </div>
                  <p class="text-slate-400 text-xs leading-relaxed italic line-clamp-2 mb-3">"{msg.message}"</p>
                  <div class="text-[9px] font-bold text-slate-600 uppercase tracking-tighter">{new Date(msg.createdAt!).toLocaleString()}</div>
                </div>
              ))}
              {messages.length === 0 && <p class="text-center py-10 text-slate-500 font-bold uppercase tracking-widest italic text-[10px]">No messages yet</p>}
            </div>
          </div>
          {/* Comment Moderation */}
          <div class="bg-white/5 border border-white/10 rounded-[2.5rem] p-6 sm:p-8 backdrop-blur-xl overflow-hidden">
            <h2 class="text-xl sm:text-2xl font-black italic mb-8">COMMENT <span class="text-red-700">MODERATION</span></h2>
            <div class="space-y-4 max-h-[500px] overflow-y-auto pr-2">
              {(await db.select().from(commentTable).orderBy(desc(commentTable.createdAt))).map(comment => (
                <div class="p-4 bg-slate-950/30 border border-white/5 rounded-xl">
                  <div class="flex flex-col sm:flex-row justify-between items-start gap-2 mb-2">
                    <div>
                      <span class="text-[10px] font-black text-slate-500 uppercase tracking-widest">{comment.name}</span>
                      <p class="text-[10px] text-red-500 font-bold truncate max-w-[150px]">{comment.email}</p>
                    </div>
                    <form action={`/admin/comments/delete/${comment.id}`} method="post" onsubmit="return confirm('Delete this comment?')">
                      <button type="submit" class="text-slate-700 hover:text-red-500 transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                      </button>
                    </form>
                  </div>
                  <p class="text-xs text-slate-400 line-clamp-2 italic">"{comment.content}"</p>
                </div>
              ))}
              {(await db.select().from(commentTable)).length === 0 && <p class="text-center text-slate-500 py-10 font-bold italic">No comments yet</p>}
            </div>
          </div>
        </div>





      </div>
    </Layout>
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
    <Layout title="Visitor Insights | Admin" user={user}>
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
    </Layout>
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
    <Layout title={`${post ? 'Edit' : 'New'} Post | Admin`} user={user}>
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
            <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Atau Upload Cover Image Baru</label>
            <input type="file" name="coverImageFile" accept="image/*" class="w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-red-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white hover:file:bg-red-800 cursor-pointer transition-all" />
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
    </Layout>
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
  const safeName = `${Date.now()}-${file.name.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '')}`;
  const key = `${folder}/${safeName}`;
  const buffer = await file.arrayBuffer();
  
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: Buffer.from(buffer),
    ContentType: file.type,
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

// --- CONTACT ADMIN ---
app.post('/admin/contacts/delete/:id', async (c) => {
  await db.delete(contactTable).where(eq(contactTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin');
});

app.post('/admin/contacts/read/:id', async (c) => {
  await db.update(contactTable).set({ isRead: 1 }).where(eq(contactTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin');
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

function renderProjectForm(c: any, project: any = null, user: any = null) {
  const inputClass = "peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent";
  const labelClass = "absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-slate-500 peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-placeholder-shown:lowercase peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500 peer-focus:uppercase peer-focus:font-bold peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:text-red-500 peer-[:not(:placeholder-shown)]:uppercase peer-[:not(:placeholder-shown)]:font-bold";

  return c.html(
    <Layout title={`${project ? 'Edit' : 'New'} Project | Admin`} user={user}>
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
              <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest pl-1">Atau Upload Thumbnail Baru</label>
              <input type="file" name="projectImageFile" accept="image/*" class="w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 py-4 text-sm text-slate-300 file:mr-4 file:rounded-lg file:border-0 file:bg-red-700 file:px-4 file:py-2 file:text-xs file:font-black file:text-white hover:file:bg-red-800 cursor-pointer transition-all" />
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
    </Layout>
  );
}

function renderSettingsForm(c: any, settings: any, user: any = null) {
  const inputClass = "peer w-full bg-slate-950/50 border border-white/10 rounded-2xl px-5 pt-7 pb-3 focus:outline-none focus:border-red-500 transition-all text-white text-lg placeholder-transparent";
  const labelClass = "absolute left-5 top-5 text-slate-500 text-xs font-bold uppercase tracking-widest transition-all pointer-events-none peer-placeholder-shown:text-slate-500 peer-placeholder-shown:text-base peer-placeholder-shown:top-5 peer-placeholder-shown:font-medium peer-placeholder-shown:lowercase peer-focus:top-2 peer-focus:text-[10px] peer-focus:text-red-500 peer-focus:uppercase peer-focus:font-bold peer-[:not(:placeholder-shown)]:top-2 peer-[:not(:placeholder-shown)]:text-[10px] peer-[:not(:placeholder-shown)]:text-red-500 peer-[:not(:placeholder-shown)]:uppercase peer-[:not(:placeholder-shown)]:font-bold";

  return c.html(
    <Layout title="Home Settings | Admin" user={user}>
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
    </Layout>
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
  return c.redirect('/admin');
});

app.post('/admin/contacts/delete/:id', async (c) => {
  await db.delete(contactTable).where(eq(contactTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin');
});

app.post('/admin/comments/delete/:id', async (c) => {
  await db.delete(commentTable).where(eq(commentTable.id, parseInt(c.req.param('id'))));
  return c.redirect('/admin');
});

// Profile saving moved to main profiling section above



export { app };

export default {
  port: Number(process.env.PORT || 4128),
  hostname: '0.0.0.0',
  fetch: app.fetch,
};
