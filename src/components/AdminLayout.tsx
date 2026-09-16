/** @jsx jsx */
import { jsx } from 'hono/jsx';

type AdminUser = {
  name: string;
  email: string;
  picture?: string;
  role?: string;
};

type AdminLayoutProps = {
  title: string;
  children: any;
  currentPath?: string;
  notificationCount?: number;
  user?: AdminUser;
  showNavigation?: boolean;
};

export const AdminLayout = (props: AdminLayoutProps) => {
  const { currentPath = '', user, notificationCount = 0, showNavigation = true } = props;
  const isDashboard = currentPath === '/admin';
  const isJejak = currentPath.startsWith('/admin/activities');
  const isSettings = currentPath.startsWith('/admin/settings');

  const navItem = (active: boolean) => `flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-all ${active ? 'bg-cyan-500/10 text-cyan-300' : 'text-slate-400 hover:bg-white/5 hover:text-white'}`;
  const mobileNavItem = (active: boolean) => `admin-bottom-item flex min-w-0 flex-1 flex-col items-center gap-1 rounded-2xl px-2 py-2 text-[10px] font-black uppercase tracking-wider transition-all ${active ? 'bg-cyan-500/15 text-cyan-300' : 'text-slate-500 hover:text-slate-200'}`;

  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{props.title}</title>
        <meta name="theme-color" content="#090d14" />
        <link rel="icon" type="image/png" href="/static/favicon.png" />
        <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet" />
        <style>{`
          body { font-family: 'Outfit', sans-serif; }
          .admin-shell { background: radial-gradient(circle at 15% 0%, rgba(8, 145, 178, 0.12), transparent 32rem), #090d14; }
          .admin-bottom-item svg { transition: transform 180ms ease; }
          .admin-bottom-item.active svg { transform: translateY(-1px) scale(1.08); }
          @media (max-width: 767px) {
            .admin-content { padding-bottom: calc(7.5rem + env(safe-area-inset-bottom)); }
          }
        `}</style>
      </head>
      <body class="admin-shell min-h-screen overflow-x-hidden text-slate-100 selection:bg-cyan-500/30">
        <header class="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-[#090d14]/90 px-4 py-3 backdrop-blur-xl md:px-8 md:py-4">
          <div class="mx-auto flex max-w-7xl items-center justify-between gap-4">
            <div class="flex min-w-0 items-center gap-3">
              <a href="/admin" class="shrink-0 text-lg font-black tracking-[0.18em] text-cyan-300 md:text-xl">FERILEE</a>
              <span class="hidden rounded-md border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-cyan-300 sm:inline-block">CMS</span>
              <span class="hidden h-5 w-px bg-white/10 md:block"></span>
              <span class="hidden truncate text-sm font-bold text-slate-400 md:block">Admin workspace</span>
            </div>

            {showNavigation && (
              <nav class="hidden items-center gap-1 md:flex">
                <a href="/admin" class={navItem(isDashboard)}>Dashboard</a>
                <a href="/admin#jejak" class={navItem(isJejak)}>Jejak</a>
                <a href="/admin#inbox" class={navItem(false)}>Inbox{notificationCount > 0 && <span class="rounded-full bg-red-600 px-1.5 py-0.5 text-[9px] text-white">{notificationCount}</span>}</a>
                <a href="/admin/settings" class={navItem(isSettings)}>Settings</a>
                <a href="/" class="ml-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-bold text-slate-400 transition-all hover:border-cyan-400/30 hover:text-white">View site</a>
              </nav>
            )}

            <div class="flex shrink-0 items-center gap-2">
              {notificationCount > 0 && (
                <a href="/admin#inbox" class="relative flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-300 hover:text-white md:hidden" aria-label={`${notificationCount} unread messages`}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>
                  <span class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-[#090d14] bg-red-600 px-1 text-[9px] font-black text-white">{notificationCount}</span>
                </a>
              )}
              {user && (
                <div class="group relative">
                  <button class="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-1.5 pr-2 transition-all hover:border-cyan-400/30 focus:outline-none" aria-label="Open account menu">
                    <span class="flex h-8 w-8 overflow-hidden rounded-lg bg-slate-800">
                      {user.picture ? <img src={user.picture} alt={user.name} class="h-full w-full object-cover" /> : <span class="flex h-full w-full items-center justify-center text-xs font-black text-cyan-300">{user.name.charAt(0).toUpperCase()}</span>}
                    </span>
                    <span class="hidden max-w-28 truncate text-xs font-bold text-slate-300 lg:block">{user.name}</span>
                  </button>
                  <div class="invisible absolute right-0 top-12 w-48 translate-y-1 rounded-2xl border border-white/10 bg-slate-900 p-2 opacity-0 shadow-2xl transition-all group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100">
                    <a href="/" class="block rounded-xl px-3 py-2.5 text-sm font-bold text-slate-300 hover:bg-white/5 hover:text-white">View site</a>
                    <a href="/auth/logout" class="block rounded-xl px-3 py-2.5 text-sm font-bold text-red-400 hover:bg-red-500/10">Sign out</a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main class={`admin-content min-h-screen pt-20 md:pt-24 ${showNavigation ? 'pb-28 md:pb-0' : 'pb-8'}`}>
          {props.children}
        </main>

        {showNavigation && (
          <div>
            <nav class="fixed inset-x-4 bottom-4 z-50 flex items-center gap-1 rounded-[1.65rem] border border-white/10 bg-slate-900/90 p-2 shadow-2xl shadow-black/30 backdrop-blur-2xl md:hidden" style="padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));">
              <a href="/admin" class={mobileNavItem(isDashboard)} aria-current={isDashboard ? 'page' : undefined}>
                <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                Dashboard
              </a>
              <a href="/admin#jejak" class={mobileNavItem(isJejak)} aria-current={isJejak ? 'page' : undefined}>
                <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 1-2-2Z"/><path d="M8 7h8M8 11h6M8 15h4"/></svg>
                Jejak
              </a>
              <a href="/admin#inbox" class={mobileNavItem(false)}>
                <span class="relative">
                  <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>{notificationCount > 0 && <circle cx="18" cy="6" r="3" fill="currentColor" stroke="none"/>}</svg>
                </span>
                Inbox
              </a>
              <button type="button" class={mobileNavItem(false)} onclick="document.getElementById('admin-more').classList.remove('hidden')">
                <svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
                More
              </button>
            </nav>

            <div id="admin-more" class="hidden fixed inset-0 z-[60] bg-slate-950/70 backdrop-blur-sm" onclick="this.classList.add('hidden')">
              <div class="absolute inset-x-0 bottom-0 rounded-t-[2rem] border-t border-white/10 bg-slate-900 p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-2xl" onclick="event.stopPropagation()">
                <div class="mx-auto mb-5 h-1 w-12 rounded-full bg-white/15"></div>
                <div class="mb-5 flex items-center justify-between"><div><p class="text-[10px] font-black uppercase tracking-widest text-cyan-300">Admin menu</p><h2 class="mt-1 text-xl font-black">More tools</h2></div><button type="button" class="rounded-xl p-2 text-slate-500 hover:bg-white/5 hover:text-white" onclick="document.getElementById('admin-more').classList.add('hidden')" aria-label="Close menu">×</button></div>
                <div class="grid grid-cols-2 gap-3">
                  <a href="/admin/blog/new" class="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm font-bold text-slate-200 hover:border-cyan-400/30">New blog post</a>
                  <a href="/admin/projects/new" class="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm font-bold text-slate-200 hover:border-cyan-400/30">New project</a>
                  <a href="/admin/settings" class="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm font-bold text-slate-200 hover:border-cyan-400/30">Home settings</a>
                  <a href="/admin/visitors" class="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm font-bold text-slate-200 hover:border-cyan-400/30">Visitors</a>
                  <a href="/" class="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm font-bold text-slate-200 hover:border-cyan-400/30">View public site</a>
                  <a href="/auth/logout" class="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm font-bold text-red-300 hover:bg-red-500/10">Sign out</a>
                </div>
              </div>
            </div>
          </div>
        )}
      </body>
    </html>
  );
};
