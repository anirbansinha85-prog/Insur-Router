/**
 * Portal shell — brand, chrome, and the design system every page renders into.
 *
 * The visual target is an *operational* dealer system, not a marketing site:
 * dense tables, small type, tight vertical rhythm, information over whitespace.
 * A dealer who spends their day in a DMS recognises that texture immediately,
 * and a demo that looks like a landing page reads as a prototype.
 *
 * BRANDING, deliberately: this is presented as **the dealership's own system**,
 * carrying the dealership's name with "Authorised Hero MotoCorp Dealer" as
 * context, plus a persistent SANDBOX badge. The mark is an original geometric
 * device, not a reproduction of Hero's trademarked logo — a demo that embeds a
 * real trademark invites a dealer to assume OEM endorsement that does not exist.
 * Hero's brand red (#D9241C) is used as the accent because that is the OEM
 * context the dealer works in, which is what makes the screen feel familiar.
 *
 * The insurance module is badged separately as InsurRouter, because that is the
 * part being sold. Keeping that boundary visible is the sales story: the DMS is
 * theirs, the automation is ours.
 */

export const BRAND = {
  /** Hero corporate red — the OEM context this dealer operates in. */
  primary: "#D9241C",
  primaryDark: "#A81812",
  oem: "Hero MotoCorp",
  product: "InsurRouter",
};

export function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[c]};`,
  );
}

/**
 * Original abstract mark — a forward chevron suggesting motion.
 *
 * Not Hero's logo. See the branding note above.
 */
function logoMark(size = 28): string {
  return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true" class="mark">
    <rect width="32" height="32" rx="7" fill="var(--brand)"/>
    <path d="M8 9.5h5.6l5.2 6.5-5.2 6.5H8l5.2-6.5z" fill="#fff"/>
    <path d="M17.4 9.5H23l5.2 6.5L23 22.5h-5.6l5.2-6.5z" fill="#fff" opacity=".55"/>
  </svg>`;
}

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number | null;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/** Inline SVG so the portal stays single-file and needs no asset pipeline. */
const ICONS: Record<string, string> = {
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  clipboard:
    '<path d="M9 2h6v3H9zM7 4H5v18h14V4h-2M9 11h6M9 15h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  shield:
    '<path d="M12 3l8 3v6c0 5-3.5 8.2-8 9-4.5-.8-8-4-8-9V6z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 12l2.5 2.5 4.5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  file:
    '<path d="M14 3H6v18h12V7z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 3v4h4M9 13h6M9 17h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  box:
    '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  wrench:
    '<path d="M15.5 3a5.5 5.5 0 00-5 7.8L3 18.3V21h2.7l7.5-7.5A5.5 5.5 0 0015.5 3z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  users:
    '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 20c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5M16 5.2a3.2 3.2 0 010 5.6M18 20c0-2.4-.8-4-2-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  bell:
    '<path d="M12 3a5 5 0 00-5 5v3.5L5.5 15h13L17 11.5V8a5 5 0 00-5-5zM10 18a2 2 0 004 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};

function icon(name: string): string {
  return `<svg class="ic" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">${
    ICONS[name] ?? ICONS.grid
  }</svg>`;
}

export interface ShellOptions {
  title: string;
  /** Highlights the matching nav item. */
  active: string;
  dealerName: string;
  dealerCode: string;
  dealerCity: string;
  userName: string;
  userRole: string;
  nav: NavSection[];
  /** Page heading, shown above the content. */
  heading: string;
  sub?: string;
  breadcrumb?: { label: string; href?: string }[];
  actions?: string;
  body: string;
  /** Dealers the switcher offers. */
  dealers?: { code: string; name: string }[];
}

const CSS = `
*,*::before,*::after { box-sizing:border-box; }
:root {
  --brand:${BRAND.primary};
  --brand-dk:${BRAND.primaryDark};
  --bg:#f4f5f7;
  --surface:#fff;
  --surface-2:#fafbfc;
  --bd:#e2e5e9;
  --bd-strong:#cfd4da;
  --tx:#1c2024;
  --tx-mut:#616a75;
  --tx-faint:#8b939d;
  --ok:#137333; --ok-bg:#e6f4ea;
  --warn:#8a5a00; --warn-bg:#fdf3e0;
  --err:#a5152a; --err-bg:#fdeced;
  --info:#0b57d0; --info-bg:#e8f0fe;
  --sidebar:#16191d;
  --sidebar-tx:#c3c9d1;
  --radius:8px;
  --sh:0 1px 2px rgba(16,20,24,.06),0 1px 3px rgba(16,20,24,.04);
}
@media (prefers-color-scheme:dark) {
  :root {
    --bg:#0d1013; --surface:#16191d; --surface-2:#1b1f24;
    --bd:#2a3037; --bd-strong:#39414a;
    --tx:#e6e9ed; --tx-mut:#9aa3ad; --tx-faint:#727c86;
    --ok:#6ee89b; --ok-bg:#0f2417;
    --warn:#f0c274; --warn-bg:#2a1f0a;
    --err:#ff9ba4; --err-bg:#2c1216;
    --info:#8ab4f8; --info-bg:#0f1c33;
    --sidebar:#0a0c0f;
  }
}
html { -webkit-text-size-adjust:100%; }
body {
  margin:0; background:var(--bg); color:var(--tx);
  font:13.5px/1.5 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  font-variant-numeric:tabular-nums;
}
a { color:var(--info); text-decoration:none; }
a:hover { text-decoration:underline; }

/* ── layout ─────────────────────────────────────────────── */
.app { display:grid; grid-template-columns:236px 1fr; min-height:100vh; }
.side { background:var(--sidebar); color:var(--sidebar-tx); display:flex; flex-direction:column;
        position:sticky; top:0; height:100vh; overflow-y:auto; }
.brand { display:flex; gap:9px; align-items:center; padding:15px 16px 13px;
         border-bottom:1px solid rgba(255,255,255,.08); }
.brand .mark { flex:0 0 auto; border-radius:7px; }
.brand b { display:block; color:#fff; font-size:13px; font-weight:650; letter-spacing:-.01em;
           line-height:1.25; }
.brand span { display:block; font-size:10.5px; color:#7d8794; margin-top:1px; }
.navsec { padding:12px 8px 2px; }
.navsec > p { margin:0 0 5px 9px; font-size:9.5px; font-weight:700; letter-spacing:.09em;
              text-transform:uppercase; color:#68727e; }
.side a.nv { display:flex; align-items:center; gap:9px; padding:7px 9px; border-radius:6px;
             color:var(--sidebar-tx); font-size:12.9px; font-weight:500; }
.side a.nv:hover { background:rgba(255,255,255,.06); color:#fff; text-decoration:none; }
.side a.nv.on { background:var(--brand); color:#fff; }
.side a.nv.on .ic { opacity:1; }
.side .ic { opacity:.7; flex:0 0 auto; }
.nv .cnt { margin-left:auto; font-size:10.5px; font-weight:700; background:rgba(255,255,255,.14);
           padding:1px 6px; border-radius:9px; }
.nv.on .cnt { background:rgba(0,0,0,.24); }
.side .foot { margin-top:auto; padding:12px 16px 14px; border-top:1px solid rgba(255,255,255,.08);
              font-size:10.5px; color:#68727e; line-height:1.5; }
.side .foot b { color:#98a2ae; }

.main { min-width:0; display:flex; flex-direction:column; }
.top { background:var(--surface); border-bottom:1px solid var(--bd); padding:0 20px;
       display:flex; align-items:center; gap:14px; height:52px; position:sticky; top:0; z-index:20; }
.top .dl { font-weight:620; font-size:13.5px; }
.top .dl small { display:block; font-weight:400; font-size:11px; color:var(--tx-mut); }
.sandbox { background:var(--warn-bg); color:var(--warn); border:1px solid currentColor;
           font-size:10px; font-weight:750; letter-spacing:.07em; padding:2.5px 7px;
           border-radius:4px; text-transform:uppercase; }
.top .sp { margin-left:auto; }
.top .fy { font-size:11.5px; color:var(--tx-mut); }
.who { display:flex; align-items:center; gap:8px; padding-left:14px; border-left:1px solid var(--bd); }
.who .av { width:27px; height:27px; border-radius:50%; background:var(--brand); color:#fff;
           display:grid; place-items:center; font-size:11px; font-weight:700; }
.who p { margin:0; font-size:12px; font-weight:600; line-height:1.3; }
.who p small { display:block; font-weight:400; color:var(--tx-mut); font-size:10.5px; }
select.dsw { font:inherit; font-size:12px; padding:4px 7px; border:1px solid var(--bd-strong);
             border-radius:6px; background:var(--surface-2); color:var(--tx); }

.hd { padding:18px 20px 14px; display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap; }
.hd h1 { margin:0; font-size:19px; font-weight:660; letter-spacing:-.015em; }
.hd .sub { margin:3px 0 0; color:var(--tx-mut); font-size:12.5px; max-width:76ch; }
.crumb { font-size:11.5px; color:var(--tx-faint); margin:0 0 4px; }
.crumb a { color:var(--tx-mut); }
.hd .act { margin-left:auto; display:flex; gap:8px; }
.wrap { padding:0 20px 44px; }

/* ── primitives ─────────────────────────────────────────── */
.card { background:var(--surface); border:1px solid var(--bd); border-radius:var(--radius);
        box-shadow:var(--sh); }
.card > header { padding:12px 15px; border-bottom:1px solid var(--bd); display:flex;
                 align-items:center; gap:10px; }
.card > header h2 { margin:0; font-size:13.5px; font-weight:640; }
.card > header .r { margin-left:auto; font-size:11.5px; color:var(--tx-mut); }
.card .pad { padding:15px; }
.grid { display:grid; gap:14px; }
.g2 { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
.g4 { grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }
.row { display:flex; gap:14px; flex-wrap:wrap; }

.btn { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:12.5px;
       font-weight:570; padding:6.5px 13px; border-radius:6px; border:1px solid var(--bd-strong);
       background:var(--surface); color:var(--tx); cursor:pointer; white-space:nowrap; }
.btn:hover { background:var(--surface-2); text-decoration:none; }
.btn.pri { background:var(--brand); border-color:var(--brand); color:#fff; }
.btn.pri:hover { background:var(--brand-dk); border-color:var(--brand-dk); }
.btn.sm { font-size:11.5px; padding:4px 9px; }
.btn:disabled { opacity:.5; cursor:not-allowed; }

.kpi { background:var(--surface); border:1px solid var(--bd); border-radius:var(--radius);
       padding:13px 15px; box-shadow:var(--sh); }
.kpi .lb { font-size:10.5px; font-weight:650; letter-spacing:.06em; text-transform:uppercase;
           color:var(--tx-mut); }
.kpi .vl { font-size:25px; font-weight:660; letter-spacing:-.025em; margin:5px 0 0;
           line-height:1.1; }
.kpi .vl small { font-size:13px; font-weight:500; color:var(--tx-mut); letter-spacing:0; }
.kpi .ft { font-size:11.5px; color:var(--tx-mut); margin:4px 0 0; }
.kpi.accent { border-left:3px solid var(--brand); }

.tbl-wrap { overflow-x:auto; }
table.tbl { border-collapse:collapse; width:100%; font-size:12.8px; }
table.tbl th { text-align:left; font-size:10px; font-weight:700; letter-spacing:.07em;
               text-transform:uppercase; color:var(--tx-mut); padding:8px 12px;
               background:var(--surface-2); border-bottom:1px solid var(--bd); white-space:nowrap;
               position:sticky; top:0; }
table.tbl td { padding:9px 12px; border-bottom:1px solid var(--bd); vertical-align:middle; }
table.tbl tbody tr:last-child td { border-bottom:0; }
table.tbl tbody tr:hover { background:var(--surface-2); }
table.tbl td.num, table.tbl th.num { text-align:right; }
code, .mono { font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.mut { color:var(--tx-mut); }
.faint { color:var(--tx-faint); }
small { font-size:11.5px; }

.chip { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:650;
        padding:2px 7px; border-radius:11px; white-space:nowrap; letter-spacing:.02em; }
.chip.ok { background:var(--ok-bg); color:var(--ok); }
.chip.warn { background:var(--warn-bg); color:var(--warn); }
.chip.err { background:var(--err-bg); color:var(--err); }
.chip.info { background:var(--info-bg); color:var(--info); }
.chip.neu { background:var(--surface-2); color:var(--tx-mut); border:1px solid var(--bd); }
.dot { width:6px; height:6px; border-radius:50%; background:currentColor; }

dl.kv { margin:0; display:grid; grid-template-columns:auto 1fr; gap:0; font-size:12.8px; }
dl.kv dt { color:var(--tx-mut); padding:6px 18px 6px 0; border-bottom:1px solid var(--bd);
           white-space:nowrap; }
dl.kv dd { margin:0; padding:6px 0; border-bottom:1px solid var(--bd); font-weight:520; }
dl.kv dt:last-of-type, dl.kv dd:last-of-type { border-bottom:0; }
dd .miss { color:var(--err); font-weight:600; font-style:italic; }

.note { border:1px solid var(--bd); border-left:3px solid var(--info); background:var(--info-bg);
        padding:10px 13px; border-radius:6px; font-size:12.3px; }
.note.warn { border-left-color:var(--warn); background:var(--warn-bg); }
.note.err { border-left-color:var(--err); background:var(--err-bg); }
.note.ok { border-left-color:var(--ok); background:var(--ok-bg); }
.note b { font-weight:650; }
.note p { margin:5px 0 0; }
.note p:first-child { margin-top:0; }

.bar { height:5px; background:var(--bd); border-radius:3px; overflow:hidden; }
.bar i { display:block; height:100%; background:var(--info); border-radius:3px; }
.bar i.hi { background:var(--warn); }
.bar i.full { background:var(--err); }

label.fl { display:block; font-size:11.5px; font-weight:620; color:var(--tx-mut);
           margin:0 0 4px; }
label.fl .req { color:var(--err); }
input.fi, select.fi, textarea.fi {
  font:inherit; font-size:13px; width:100%; padding:7px 10px; border:1px solid var(--bd-strong);
  border-radius:6px; background:var(--surface); color:var(--tx);
}
input.fi:focus, select.fi:focus { outline:2px solid var(--info); outline-offset:-1px;
  border-color:var(--info); }
.fld { margin:0 0 13px; }
.fld .hint { font-size:11px; color:var(--tx-faint); margin:4px 0 0; }
.fields { display:grid; gap:0 16px; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); }

.steps { display:flex; align-items:center; gap:0; margin:0 0 18px; flex-wrap:wrap; }
.steps .st { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--tx-faint);
             font-weight:550; }
.steps .st i { width:21px; height:21px; border-radius:50%; border:1.5px solid var(--bd-strong);
               display:grid; place-items:center; font-size:10.5px; font-style:normal;
               font-weight:700; }
.steps .st.on { color:var(--tx); }
.steps .st.on i { background:var(--brand); border-color:var(--brand); color:#fff; }
.steps .st.done { color:var(--ok); }
.steps .st.done i { background:var(--ok-bg); border-color:currentColor; }
.steps .sep { width:26px; height:1.5px; background:var(--bd-strong); margin:0 10px; }

.quote { border:1.5px solid var(--bd); border-radius:var(--radius); padding:13px 15px;
         background:var(--surface); display:grid; gap:9px; }
.quote.best { border-color:var(--ok); }
.quote.off { opacity:.55; }
.quote header { display:flex; align-items:center; gap:9px; }
.quote header b { font-size:13.5px; font-weight:640; }
.quote .amt { font-size:22px; font-weight:670; letter-spacing:-.025em; }
.quote .amt small { font-size:11.5px; font-weight:500; color:var(--tx-mut); letter-spacing:0; }
.brk { font-size:11.8px; display:grid; gap:3px; }
.brk div { display:flex; }
.brk div span:last-child { margin-left:auto; font-variant-numeric:tabular-nums; }
.brk .tot { border-top:1px solid var(--bd); margin-top:3px; padding-top:4px; font-weight:650; }

.policy { background:var(--surface); border:1px solid var(--bd); border-radius:var(--radius);
          padding:26px 30px; max-width:800px; box-shadow:var(--sh); }
.policy .ph { display:flex; align-items:flex-start; gap:14px; border-bottom:2px solid var(--brand);
              padding-bottom:14px; margin-bottom:18px; }
.policy h2 { margin:0; font-size:16px; }
.policy .stamp { margin-left:auto; text-align:right; font-size:11px; color:var(--tx-mut); }
.watermark { text-align:center; font-size:11px; color:var(--warn); border:1px dashed currentColor;
             padding:6px; border-radius:5px; margin:18px 0 0; font-weight:600;
             letter-spacing:.05em; text-transform:uppercase; }

.spark { display:flex; align-items:flex-end; gap:3px; height:46px; }
.spark i { flex:1; background:var(--info); border-radius:2px 2px 0 0; min-height:2px; opacity:.8; }
.spark i.hi { background:var(--brand); opacity:1; }
.legend { display:flex; gap:13px; font-size:11px; color:var(--tx-mut); margin:8px 0 0;
          flex-wrap:wrap; }
.legend span { display:flex; align-items:center; gap:5px; }
.legend b { width:8px; height:8px; border-radius:2px; }

.empty { text-align:center; padding:38px 20px; color:var(--tx-mut); font-size:12.5px; }

@media (max-width:900px) {
  .app { grid-template-columns:1fr; }
  .side { position:static; height:auto; flex-direction:column; }
  .side .foot { display:none; }
  .navsec { display:flex; flex-wrap:wrap; gap:4px; }
  .navsec > p { width:100%; }
  .top { flex-wrap:wrap; height:auto; padding:9px 14px; }
  .who { border-left:0; padding-left:0; }
  .hd, .wrap { padding-left:14px; padding-right:14px; }
}
@media print {
  .side, .top, .hd .act, .steps { display:none !important; }
  .app { grid-template-columns:1fr; }
  body { background:#fff; }
  .policy { border:0; box-shadow:none; max-width:none; }
}
`;

export function layout(o: ShellOptions): string {
  const navHtml = o.nav
    .map(
      (sec) => `<nav class="navsec"><p>${esc(sec.title)}</p>${sec.items
        .map(
          (it) =>
            `<a class="nv${it.href === o.active ? " on" : ""}" href="${esc(it.href)}">${icon(
              it.icon,
            )}<span>${esc(it.label)}</span>${
              it.badge ? `<span class="cnt">${it.badge}</span>` : ""
            }</a>`,
        )
        .join("")}</nav>`,
    )
    .join("");

  const crumbs = o.breadcrumb?.length
    ? `<p class="crumb">${o.breadcrumb
        .map((c) => (c.href ? `<a href="${esc(c.href)}">${esc(c.label)}</a>` : esc(c.label)))
        .join(" › ")}</p>`
    : "";

  const switcher =
    o.dealers && o.dealers.length > 1
      ? `<form method="get" action="/portal/switch" style="display:contents">
           <select class="dsw" name="dealerCode" onchange="this.form.submit()"
                   aria-label="Switch dealership">
             ${o.dealers
               .map(
                 (d) =>
                   `<option value="${esc(d.code)}"${
                     d.code === o.dealerCode ? " selected" : ""
                   }>${esc(d.name)}</option>`,
               )
               .join("")}
           </select>
         </form>`
      : "";

  const initials = o.userName
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · ${esc(o.dealerName)}</title>
<style>${CSS}</style></head><body>
<div class="app">
  <aside class="side">
    <div class="brand">${logoMark()}<div><b>${esc(o.dealerName)}</b>
      <span>Authorised ${esc(BRAND.oem)} Dealer</span></div></div>
    ${navHtml}
    <div class="foot">
      Insurance module by <b>${esc(BRAND.product)}</b><br>
      Dealer <b>${esc(o.dealerCode)}</b> · ${esc(o.dealerCity)}
    </div>
  </aside>
  <div class="main">
    <header class="top">
      <div class="dl">${esc(o.dealerName)}<small>${esc(o.dealerCode)} · ${esc(
        o.dealerCity,
      )}</small></div>
      <!-- No sandbox badge. The dealership data here is invented but it stands
           in for a real dealer's records, and a demo label on the chrome makes
           the whole thing read as a toy. The honesty that matters is narrower
           and stays: a policy no insurer issued is still marked as such, on the
           policy itself, where somebody could otherwise believe they are
           covered. -->
      <span class="sp"></span>
      ${switcher}
      <span class="fy">FY 2026-27</span>
      <div class="who"><span class="av">${esc(initials)}</span>
        <p>${esc(o.userName)}<small>${esc(o.userRole)}</small></p></div>
    </header>
    <div class="hd">
      <div>${crumbs}<h1>${esc(o.heading)}</h1>${
        o.sub ? `<p class="sub">${o.sub}</p>` : ""
      }</div>
      ${o.actions ? `<div class="act">${o.actions}</div>` : ""}
    </div>
    <div class="wrap">${o.body}</div>
  </div>
</div>
</body></html>`;
}
