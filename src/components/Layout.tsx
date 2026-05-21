/** @jsx jsx */
import { jsx } from 'hono/jsx';

export const Layout = (props: { title: string; children: any; notificationCount?: number; ogImage?: string; currentPath?: string; needsProfiling?: boolean; user?: { email: string; name: string; picture?: string; role: string } }) => {
  const { user, currentPath } = props;

  return (
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>{props.title}</title>
      <meta name="description" content="Ferilee | Extraordinary Digital Showcase - High-performance portfolio and blog built with Bun, Hono, and Drizzle ORM." />
      
      {/* Open Graph / Facebook */}
      <meta property="og:type" content="website" />
      <meta property="og:url" content="https://ferilee.dev/" />
      <meta property="og:title" content={props.title} />
      <meta property="og:description" content="Explore my portfolio, technical blog, and career journey in fullstack development." />
      <meta property="og:image" content={props.ogImage || "/static/ferilee.png"} />

      {/* Twitter */}
      <meta property="twitter:card" content="summary_large_image" />
      <meta property="twitter:url" content="https://ferilee.dev/" />
      <meta property="twitter:title" content={props.title} />
      <meta property="twitter:description" content="Explore my portfolio, technical blog, and career journey in fullstack development." />
      <meta property="twitter:image" content={props.ogImage || "/static/ferilee.png"} />

      <link rel="icon" type="image/png" href="/static/favicon.png" />
      <link rel="manifest" href="/static/manifest.json" />
      <meta name="theme-color" content="#b91c1c" />
      <link rel="apple-touch-icon" href="/static/favicon.png" />
      
      <script src="https://cdn.tailwindcss.com"></script>
      <script dangerouslySetInnerHTML={{ __html: `
        (function () {
          function setOfflineBadge() {
            var badge = document.getElementById('offline-badge');
            if (!badge) return;
            if (navigator.onLine) {
              badge.classList.add('hidden');
            } else {
              badge.classList.remove('hidden');
            }
          }

          window.addEventListener('online', setOfflineBadge);
          window.addEventListener('offline', setOfflineBadge);
          document.addEventListener('visibilitychange', setOfflineBadge);

          if ('serviceWorker' in navigator) {
            window.addEventListener('load', function () {
              navigator.serviceWorker.register('/static/sw.js').catch(function (err) {
                console.log('SW registration failed:', err);
              });
            });
          }

          setOfflineBadge();
        })();
      `}} />

      <script src="https://unpkg.com/@dotlottie/player-component@latest/dist/dotlottie-player.mjs" type="module"></script>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet" />
      <style>{`
        body { font-family: 'Outfit', sans-serif; }
        .glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(16px); }
        .gradient-bg { background: radial-gradient(circle at center, #2a0b0b 0%, #0f0404 100%); }
        .btn-shadow { box-shadow: 0 10px 30px -10px rgba(220, 38, 38, 0.5); }
        .nav-item.active { color: #ef4444; }
        .nav-bottom-item span { 
          max-height: 0; 
          opacity: 0; 
          transform: translateY(10px); 
          transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
          overflow: hidden;
        }
        .nav-bottom-item.active span, .nav-bottom-item:hover span { 
          max-height: 20px; 
          opacity: 1; 
          transform: translateY(0);
          margin-top: 4px;
        }
        .nav-bottom-item svg { 
          transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        .nav-bottom-item.active svg, .nav-bottom-item:hover svg { 
          transform: scale(1.3) translateY(-2px);
          color: #ef4444;
        }
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        select option { background: #0f172a; color: white; }
      `}</style>
    </head>
    <body class="gradient-bg text-slate-100 min-h-screen selection:bg-red-500/30 overflow-x-hidden relative">
      <div id="offline-badge" class="hidden fixed top-4 right-4 z-[70] px-4 py-2 rounded-xl bg-red-700/80 border border-red-500/30 backdrop-blur-xl text-xs font-black uppercase tracking-widest">
        Offline
      </div>

      <header class="fixed top-0 md:top-8 w-full z-50 px-6 md:px-12 py-4 md:py-0 bg-slate-950/50 md:bg-transparent backdrop-blur-lg md:backdrop-blur-none border-b border-white/5 md:border-none">
        <div class="max-w-7xl mx-auto flex justify-between items-center">
          <a href="/" class="text-2xl font-black text-red-700 tracking-wider">Research</a>
          
          <nav class="hidden md:flex items-center space-x-1 bg-white/5 backdrop-blur-xl border border-white/10 rounded-full p-1 shadow-2xl">
            <a href="/" class={`nav-item px-6 py-2 rounded-full hover:bg-white/5 font-bold transition-all text-sm ${currentPath === '/' ? 'active text-red-500' : 'text-slate-300'}`}>Home</a>
            <a href="/projects" class={`nav-item px-6 py-2 rounded-full hover:bg-white/5 font-bold transition-all text-sm ${currentPath === '/projects' ? 'active text-red-500' : 'text-slate-300'}`}>Portfolio</a>
            <a href="/timeline" class={`nav-item px-6 py-2 rounded-full hover:bg-white/5 font-bold transition-all text-sm ${currentPath === '/timeline' ? 'active text-red-500' : 'text-slate-300'}`}>Timeline</a>
            <a href="/blog" class={`nav-item px-6 py-2 rounded-full hover:bg-white/5 font-bold transition-all text-sm ${currentPath === '/blog' ? 'active text-red-500' : 'text-slate-300'}`}>Blog</a>
            <a href="/contact" class={`nav-item px-6 py-2 rounded-full hover:bg-white/5 font-bold transition-all text-sm ${currentPath === '/contact' ? 'active text-red-500' : 'text-slate-300'}`}>Contact</a>
          </nav>

          <div class="flex items-center gap-3">
            <div class="relative">
              <button id="search-btn" class="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 transition-all text-slate-400">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              </button>
            </div>
            
            {user ? (
              <div class="flex items-center gap-3">
                {user.role === 'admin' && (
                  <div class="relative">
                    <a href="/admin" class="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 transition-all text-slate-400">
                      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
                    </a>
                    {props.notificationCount !== undefined && props.notificationCount > 0 && (
                      <div class="absolute -top-1 -right-1 w-5 h-5 bg-red-600 border-2 border-slate-950 rounded-full flex items-center justify-center animate-bounce">
                        <span class="text-[10px] font-black text-white">{props.notificationCount}</span>
                      </div>
                    )}
                  </div>
                )}
                
                <div class="flex items-center gap-2 pl-2 border-l border-white/10">
                  <div class="hidden lg:block text-right">
                    <p class="text-[10px] font-black uppercase text-red-500 tracking-tighter leading-none">{user.role}</p>
                    <p class="text-xs font-bold text-slate-300 truncate max-w-[100px]">{user.name}</p>
                  </div>
                  <div class="relative group">
                    <button class="w-10 h-10 rounded-full border border-white/10 overflow-hidden bg-white/5 hover:border-red-500/50 transition-all focus:outline-none">
                      {user.picture ? (
                        <img src={user.picture} alt={user.name} class="w-full h-full object-cover" />
                      ) : (
                        <div class="w-full h-full flex items-center justify-center text-slate-500">
                          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </div>
                      )}
                    </button>
                    <div class="absolute right-0 mt-2 w-48 bg-slate-900 border border-white/10 rounded-2xl p-2 hidden group-focus-within:block shadow-2xl backdrop-blur-xl">
                      <a href="/auth/logout" class="flex items-center gap-2 px-4 py-3 text-sm font-bold text-red-500 hover:bg-white/5 rounded-xl transition-all">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                        Sign Out
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <a href="/admin/login" class="px-6 py-2.5 bg-white/5 border border-white/10 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all">
                Login
              </a>
            )}
          </div>

        </div>
      </header>

      {/* Bottom Navigation for Mobile */}
      <nav class="md:hidden fixed bottom-6 left-6 right-6 z-50 bg-slate-900/80 backdrop-blur-2xl border border-white/10 rounded-[2.5rem] p-4 flex justify-around items-end shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
        <a href="/" class={`nav-bottom-item flex flex-col items-center transition-all ${currentPath === '/' ? 'active text-red-500' : 'text-slate-400'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span class="text-[10px] font-black uppercase tracking-widest">Home</span>
        </a>
        <a href="/projects" class={`nav-bottom-item flex flex-col items-center transition-all ${currentPath === '/projects' ? 'active text-red-500' : 'text-slate-400'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
          <span class="text-[10px] font-black uppercase tracking-widest">Work</span>
        </a>
        <a href="/timeline" class={`nav-bottom-item flex flex-col items-center transition-all ${currentPath === '/timeline' ? 'active text-red-500' : 'text-slate-400'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span class="text-[10px] font-black uppercase tracking-widest">Journey</span>
        </a>
        <a href="/blog" class={`nav-bottom-item flex flex-col items-center transition-all ${currentPath?.startsWith('/blog') ? 'active text-red-500' : 'text-slate-400'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M8 7h6"/><path d="M8 11h8"/></svg>
          <span class="text-[10px] font-black uppercase tracking-widest">Blog</span>
        </a>
        <a href="/contact" class={`nav-bottom-item flex flex-col items-center transition-all ${currentPath === '/contact' ? 'active text-red-500' : 'text-slate-400'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
          <span class="text-[10px] font-black uppercase tracking-widest">Reach</span>
        </a>
        {user?.role === 'admin' && (
          <a href="/admin" class={`nav-bottom-item flex flex-col items-center transition-all ${currentPath?.startsWith('/admin') ? 'active text-red-500' : 'text-slate-400'}`}>
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/></svg>
            <span class="text-[10px] font-black uppercase tracking-widest">Admin</span>
          </a>
        )}
      </nav>

      {/* Search Overlay */}
      <div id="search-overlay" class="fixed inset-0 z-[60] bg-red-950/30 backdrop-blur-3xl hidden flex-col items-center justify-start p-6 pt-32 transition-all duration-500 opacity-0 pointer-events-none">
        <div class="max-w-2xl w-full">
          <div class="relative group mb-8">
            <div class="absolute -inset-1 bg-gradient-to-r from-red-600 to-red-900 rounded-2xl blur opacity-25 group-focus-within:opacity-100 transition duration-500"></div>
            <input id="search-input" type="text" placeholder="Search projects, blogs, or tech..." class="relative w-full bg-slate-950 border border-white/10 rounded-2xl px-8 py-6 text-2xl font-bold focus:outline-none focus:border-red-500 transition-all placeholder:text-slate-600" />
            <button id="close-search" class="absolute right-6 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs font-bold tracking-widest">
              ESC TO CLOSE
            </button>
          </div>
          
          <div id="search-results" class="space-y-8 max-h-[60vh] overflow-y-auto pr-4 custom-scrollbar">
            <div class="text-center text-slate-500 text-sm font-bold tracking-widest uppercase">
              Start typing to see results
            </div>
          </div>
        </div>
      </div>

      <main class="min-h-screen flex flex-col justify-start pt-24 pb-48 md:pb-0">
        {props.children}
      </main>

      {/* Profiling Modal */}
      {props.needsProfiling && (
        <div id="profiling-modal" class="fixed inset-0 z-[100] bg-slate-950/80 backdrop-blur-xl flex items-center justify-center p-6">
          <div class="bg-slate-900 border border-white/10 w-full max-w-xl rounded-[2.5rem] p-10 shadow-2xl relative overflow-hidden">
            <div class="absolute -top-24 -right-24 w-64 h-64 bg-red-900/20 rounded-full blur-[100px]"></div>
            
            <header class="mb-10 relative">
              <h2 class="text-4xl font-black italic mb-2">COMPLETE <span class="text-red-700">PROFILE</span></h2>
              <p class="text-slate-400 text-sm">Welcome to Ferilee's Research. Please tell us a bit about yourself to continue.</p>
            </header>

            <form action="/api/profile/save" method="POST" class="space-y-6 relative">
              <div class="space-y-4">
                <input type="text" name="fullName" placeholder="Full Name" required class="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:border-red-500 transition-all outline-none" />
                <input type="text" name="occupation" placeholder="Occupation" required class="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:border-red-500 transition-all outline-none" />
                
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div class="space-y-1">
                    <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-2">Province</label>
                    <select id="p-prov" name="province" required class="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:border-red-500 transition-all outline-none appearance-none">
                      <option value="">Select Province</option>
                    </select>
                    <input type="hidden" name="provinceName" id="p-prov-name" />
                  </div>
                  <div class="space-y-1">
                    <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-2">Regency (Kota/Kab)</label>
                    <select id="p-reg" name="regency" required class="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:border-red-500 transition-all outline-none appearance-none">
                      <option value="">Select Regency</option>
                    </select>
                    <input type="hidden" name="regencyName" id="p-reg-name" />
                  </div>
                </div>

                <div class="space-y-1">
                  <label class="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-2">District (Kecamatan)</label>
                  <select id="p-dist" name="district" required class="w-full bg-white/5 border border-white/10 rounded-2xl px-6 py-4 text-white focus:border-red-500 transition-all outline-none appearance-none">
                    <option value="">Select District</option>
                  </select>
                  <input type="hidden" name="districtName" id="p-dist-name" />
                </div>
              </div>

              <button type="submit" class="w-full py-5 bg-red-700 hover:bg-red-800 text-white font-black rounded-2xl transition-all shadow-xl hover:scale-[1.02] active:scale-[0.98] tracking-widest uppercase mt-4">Save & Continue</button>
            </form>

            <script dangerouslySetInnerHTML={{ __html: `
              (async function() {
                const provSel = document.getElementById('p-prov');
                const regSel = document.getElementById('p-reg');
                const distSel = document.getElementById('p-dist');
                const provName = document.getElementById('p-prov-name');
                const regName = document.getElementById('p-reg-name');
                const distName = document.getElementById('p-dist-name');

                const resProv = await fetch('https://www.emsifa.com/api-wilayah-indonesia/api/provinces.json');
                const provinces = await resProv.json();
                provinces.forEach(p => provSel.add(new Option(p.name, p.id)));

                provSel.onchange = async () => {
                  provName.value = provSel.options[provSel.selectedIndex].text;
                  regSel.innerHTML = '<option value="">Select Regency</option>';
                  distSel.innerHTML = '<option value="">Select District</option>';
                  if (!provSel.value) return;
                  const resReg = await fetch(\`https://www.emsifa.com/api-wilayah-indonesia/api/regencies/\${provSel.value}.json\`);
                  const regencies = await resReg.json();
                  regencies.forEach(r => regSel.add(new Option(r.name, r.id)));
                };

                regSel.onchange = async () => {
                  regName.value = regSel.options[regSel.selectedIndex].text;
                  distSel.innerHTML = '<option value="">Select District</option>';
                  if (!regSel.value) return;
                  const resDist = await fetch(\`https://www.emsifa.com/api-wilayah-indonesia/api/districts/\${regSel.value}.json\`);
                  const districts = await resDist.json();
                  districts.forEach(d => distSel.add(new Option(d.name, d.id)));
                };

                distSel.onchange = () => distName.value = 'Kecamatan ' + distSel.options[distSel.selectedIndex].text;
              })();
            `}} />
          </div>
        </div>
      )}

      <footer class="w-full px-6 md:px-12 py-10 pb-32 md:pb-10 flex flex-col md:flex-row justify-between items-center gap-8 border-t border-white/5 mt-20">
        <div class="text-slate-500 text-sm font-medium">© {new Date().getFullYear()} All Right For ferilee.gurumuda.eu.org</div>
        
        <div class="flex gap-6 text-slate-400">
          <a href="https://instagram.com/therealferilee" target="_blank" class="hover:text-red-500 transition-all flex items-center gap-2" title="Instagram">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
            </svg>
          </a>
          <a href="https://t.me/ferilee" target="_blank" class="hover:text-red-500 transition-all flex items-center gap-2" title="Telegram">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.665 3.717l-17.73 6.837c-1.213.486-1.203 1.163-.222 1.462l4.552 1.42 1.589 4.826c.19.524.097.731.597.731.385 0 .556-.176.77-.385l2.256-2.193 4.693 3.466c.864.477 1.487.231 1.702-.803l3.073-14.505c.315-1.26-.475-1.826-1.3l-.525.104z" />
            </svg>
          </a>
          <a href="https://wa.me/6285174244128" target="_blank" class="hover:text-red-500 transition-all flex items-center gap-2" title="WhatsApp">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.301-.15-1.767-.872-2.04-.971-.272-.099-.47-.15-.669.15-.199.3-.771.971-.944 1.171-.173.199-.347.225-.648.075-.301-.15-1.27-.468-2.42-1.493-.894-.798-1.498-1.783-1.674-2.083-.174-.3-.018-.463.13-.611.134-.134.301-.351.451-.526.15-.175.199-.3.3-.5.099-.199.05-.375-.025-.525-.075-.15-.669-1.612-.916-2.207-.242-.579-.487-.501-.669-.51l-.57-.01c-.199 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.768-.721 2.016-1.417.247-.695.247-1.291.173-1.415-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.414 0 .018 5.394 0 12.03c0 2.12.54 4.19 1.563 6.02L0 24l6.122-1.605a11.845 11.845 0 005.928 1.586h.005c6.632 0 12.028-5.396 12.033-12.033a11.78 11.78 0 00-3.51-8.508z" />
            </svg>
          </a>
        </div>
      </footer>

      <script dangerouslySetInnerHTML={{ __html: `
        (function() {
          const searchBtn = document.getElementById('search-btn');
          const searchOverlay = document.getElementById('search-overlay');
          const closeSearch = document.getElementById('close-search');
          const searchInput = document.getElementById('search-input');
          const searchResults = document.getElementById('search-results');

          const toggleOverlay = (el, show) => {
            if (!el) return;
            if (show) {
              el.classList.remove('hidden');
              setTimeout(() => {
                el.classList.remove('opacity-0', 'pointer-events-none');
                el.classList.add('opacity-100', 'pointer-events-auto');
              }, 10);
              document.body.style.overflow = 'hidden';
            } else {
              el.classList.remove('opacity-100', 'pointer-events-auto');
              el.classList.add('opacity-0', 'pointer-events-none');
              setTimeout(() => el.classList.add('hidden'), 500);
              document.body.style.overflow = '';
            }
          };

          searchBtn?.addEventListener('click', () => {
            toggleOverlay(searchOverlay, true);
            searchInput?.focus();
          });
          closeSearch?.addEventListener('click', () => toggleOverlay(searchOverlay, false));

          let debounceTimer;
          searchInput?.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            clearTimeout(debounceTimer);
            if (query.length < 2) return;
            debounceTimer = setTimeout(async () => {
              const res = await fetch(\`/api/search?q=\${encodeURIComponent(query)}\`);
              const data = await res.json();
              let html = '';
              data.projects.forEach(p => {
                html += \`<a href="/projects/\${p.slug || p.id}" class="block p-4 bg-white/5 rounded-xl mb-2">\${p.title}</a>\`;
              });
              data.blog.forEach(b => {
                html += \`<a href="/blog/\${b.slug}" class="block p-4 bg-white/5 rounded-xl mb-2">\${b.title}</a>\`;
              });
              searchResults.innerHTML = html || '<p class="text-center text-slate-500">No results</p>';
            }, 300);
          });
          document.addEventListener('keydown', (e) => e.key === 'Escape' && toggleOverlay(searchOverlay, false));
        })();
      ` }} />
    </body>
    </html>
  );
};
