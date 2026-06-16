/**
 * Minimal i18n: bilingual (zh / en) string dictionary + language detection.
 * Language is chosen via the `gw_lang` cookie (default zh), toggled from the
 * header. Pages receive a `lang` and call t(lang, "key").
 */

export type Lang = "zh" | "en";
export const LANG_COOKIE = "gw_lang";

export function detectLang(cookieHeader: string | null): Lang {
  const c = getCookie(cookieHeader, LANG_COOKIE);
  if (c === "zh" || c === "en") return c;
  return "zh";
}

export function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function langCookieValue(lang: Lang): string {
  return `${LANG_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** Lookup a key; falls back to the key itself if missing (so gaps are visible). */
export function t(lang: Lang, key: string): string {
  const entry = DICT[key];
  if (!entry) return key;
  return entry[lang] ?? entry.en ?? key;
}

/** A localized string with a {n} placeholder substituted. */
export function tf(lang: Lang, key: string, ...vals: (string | number)[]): string {
  let s = t(lang, key);
  vals.forEach((v, i) => {
    s = s.replace(`{${i}}`, String(v));
  });
  return s;
}

type Entry = { zh: string; en: string };

const DICT: Record<string, Entry> = {
  // header / nav
  "nav.repos": { zh: "~/仓库", en: "~/repos" },
  "nav.login": { zh: "登录", en: "login" },
  "nav.logout": { zh: "登出", en: "logout" },
  "nav.admin": { zh: "[ 管理面板 ]", en: "[ admin ]" },
  "footer.tagline": { zh: "git-workers · 基于 Workers + 对象存储的 git 服务", en: "git-workers · git-over-workers + object storage" },
  "footer.dbmode": { zh: "数据库模式", en: "DB mode" },

  // dashboard
  "dash.title": { zh: "仓库", en: "repositories" },
  "dash.count": { zh: "{0} 个仓库 · {1}", en: "{0} repo(s) · {1}" },
  "dash.count.db": { zh: "数据库模式", en: "DB mode" },
  "dash.auth.note.token": { zh: "需要访问令牌。配置 git：", en: "Auth token required. Configure git:" },
  "dash.auth.note.open": { zh: "未设置 AUTH_TOKEN —— 任何拿到地址的人都能读/写。", en: "No AUTH_TOKEN set — anyone with the URL can read/push." },
  "dash.storages": { zh: "存储后端", en: "storage backends" },
  "dash.repos": { zh: "仓库", en: "repositories" },
  "dash.repos.found": { zh: "找到 {0} 个 · {1} 后端", en: "{0} found · {1} backend" },
  "dash.no.repos": { zh: "[ 暂无仓库 —— 在 <a href=\"/admin\">/admin</a> 添加 ]", en: "[ no repos registered — add one in <a href=\"/admin\">/admin</a> ]" },
  "dash.no.repos.env": { zh: "[ 未发现仓库 ]", en: "[ no repositories found ]" },
  "dash.col.repo": { zh: "仓库", en: "repo" },
  "dash.col.storage": { zh: "存储", en: "storage" },
  "dash.col.vis": { zh: "可见性", en: "vis" },
  "dash.col.updated": { zh: "更新时间", en: "updated" },
  "dash.col.status": { zh: "状态", en: "status" },
  "dash.create": { zh: "创建仓库", en: "create a repo" },
  "dash.create.db.hint": { zh: "数据库模式下，先在 <a href=\"/admin\">/admin → 仓库</a> 注册仓库并分配存储后端，然后：", en: "In DB mode, register the repo first in <a href=\"/admin\">/admin → repos</a>, assigning it a storage backend. Then:" },
  "dash.create.env.hint": { zh: "首次推送时自动创建仓库。", en: "A repo is created automatically on first push." },
  "dash.clone.anywhere": { zh: "任意位置克隆", en: "clone anywhere" },
  "dash.clone.then": { zh: "之后即可在界面中浏览。", en: "Then browse it in the UI." },
  "tag.pub": { zh: "公开", en: "pub" },
  "tag.priv": { zh: "私有", en: "priv" },
  "tag.ok": { zh: "正常", en: "ok" },
  "tag.nohead": { zh: "无 HEAD", en: "no HEAD" },

  // repo home
  "repo.branches.tags": { zh: "{0} 个分支 · {1} 个标签", en: "{0} branches · {1} tags" },
  "repo.no.commits": { zh: "暂无提交", en: "no commits yet" },
  "repo.empty.tree": { zh: "空仓库", en: "empty tree" },
  "repo.raw": { zh: "[原始]", en: "[raw]" },

  // admin
  "admin.title": { zh: "管理面板", en: "admin" },
  "admin.back": { zh: "[← 返回]", en: "[← back]" },
  "admin.to.admin": { zh: "[← 管理面板]", en: "[← admin]" },
  "admin.sub": { zh: "存储后端 · 仓库分配 · {0}", en: "storage backends · repository assignments · {0}" },
  "admin.enc.ok": { zh: "已加密", en: "encrypted" },
  "admin.enc.plain": { zh: "明文", en: "plaintext" },
  "admin.enc.warn": { zh: "（设置 CONFIG_KEY）", en: "(set CONFIG_KEY)" },
  "admin.storages.title": { zh: "存储后端", en: "storage backends" },
  "admin.storages.sub": { zh: "<a href=\"/admin\">[← 管理面板]</a> · 存放仓库数据的对象存储", en: "<a href=\"/admin\">[← admin]</a> · object storage that holds repo data" },
  "admin.storages.configured": { zh: "已配置", en: "configured" },
  "admin.storages.add": { zh: "添加后端", en: "add backend" },
  "admin.storages.none": { zh: "[ 暂无存储后端 ]", en: "[ no storage backends yet ]" },
  "admin.f.name": { zh: "名称", en: "name" },
  "admin.f.kind": { zh: "类型", en: "kind" },
  "admin.f.endpoint": { zh: "端点", en: "endpoint" },
  "admin.f.region": { zh: "区域", en: "region" },
  "admin.f.bucket": { zh: "存储桶", en: "bucket" },
  "admin.f.basepath": { zh: "基础路径（可选前缀）", en: "base path (optional prefix)" },
  "admin.f.accesskey": { zh: "访问密钥 ID", en: "access key id" },
  "admin.f.secretkey": { zh: "秘密访问密钥", en: "secret access key" },
  "admin.f.username": { zh: "用户名", en: "username" },
  "admin.f.password": { zh: "密码", en: "password" },
  "admin.f.creds": { zh: "凭据", en: "credentials" },
  "admin.f.creds.hint.enc": { zh: "在 D1 中以 AES-GCM 加密存储", en: "stored AES-GCM encrypted in D1" },
  "admin.f.creds.hint.plain": { zh: "在 D1 中<b>明文</b>存储（请设置 CONFIG_KEY！）", en: "stored <b>plaintext</b> (set CONFIG_KEY!)" },
  "admin.btn.add.storage": { zh: "[ 添加存储 ]", en: "[ add storage ]" },
  "admin.btn.test": { zh: "[ 测试连接 ]", en: "[ test connection ]" },
  "admin.btn.register": { zh: "[ 注册 ]", en: "[ register ]" },
  "admin.btn.del": { zh: "[删除]", en: "[del]" },
  "admin.col.name": { zh: "名称", en: "name" },
  "admin.col.kind": { zh: "类型", en: "kind" },
  "admin.col.bucket": { zh: "桶/路径", en: "bucket/path" },
  "admin.col.desc": { zh: "描述", en: "desc" },
  "admin.testing": { zh: "测试中…", en: "testing..." },
  "admin.repos.title": { zh: "仓库", en: "repositories" },
  "admin.repos.sub": { zh: "<a href=\"/admin\">[← 管理面板]</a> · 为每个仓库分配存储后端", en: "<a href=\"/admin\">[← admin]</a> · assign each repo to a storage backend" },
  "admin.repos.registered": { zh: "已注册", en: "registered" },
  "admin.repos.register": { zh: "注册仓库", en: "register repo" },
  "admin.f.reponame": { zh: "仓库名", en: "repo name" },
  "admin.f.storage": { zh: "存储后端", en: "storage backend" },
  "admin.f.visibility": { zh: "可见性", en: "visibility" },
  "admin.f.desc": { zh: "描述", en: "description" },
  "admin.repos.none": { zh: "[ 暂无注册仓库 ]", en: "[ no repos registered ]" },
  "admin.repos.addfirst": { zh: "请先添加存储后端（<a href=\"/admin/storages\">/admin/storages</a>）。", en: "Add a storage backend first (<a href=\"/admin/storages\">/admin/storages</a>)." },
  "admin.repos.afterhint": { zh: "注册后即可推送：<code>git push &lt;worker&gt;/&lt;repo&gt;</code>。在此删除仓库仅移除分配，对象仍保留在存储中。", en: "After registering, push to it: <code>git push &lt;worker&gt;/&lt;repo&gt;</code>. Deleting a repo here only removes the assignment; objects remain in storage." },
  "admin.confirm.del.storage": { zh: "删除存储 {0}？", en: "delete storage {0}?" },
  "admin.confirm.del.repo": { zh: "删除仓库 {0}？（存储中的数据不会删除）", en: "delete repo {0}? (data in storage is NOT deleted)" },
  "admin.fk.inuse": { zh: "（被仓库引用的存储无法删除 —— 请先移除仓库）", en: "(a storage in use by a repo can't be deleted — remove the repo first)" },
  "admin.quickref": { zh: "快速参考", en: "quick reference" },
  "admin.quickref.hint": { zh: "数据库模式下，仓库必须先在此注册才能 push/clone。为每个仓库分配存储后端。", en: "A repo must be registered here (in DB mode) before it can be pushed/cloned. Assign each repo a storage backend." },

  // login
  "login.ui.sub": { zh: "登录以浏览仓库", en: "authenticate to browse repositories" },
  "login.ui.btn": { zh: "[ 登录 ]", en: "[ login ]" },
  "login.ui.err": { zh: "[ERR] 令牌错误", en: "[ERR] incorrect token" },
  "login.admin.sub": { zh: "git-workers 管理面板", en: "git-workers control panel" },
  "login.admin.placeholder": { zh: "管理员密码", en: "admin password" },
  "login.admin.btn": { zh: "[ 进入 ]", en: "[ enter ]" },
  "login.admin.err": { zh: "[ERR] 密码错误", en: "[ERR] wrong password" },

  // misc
  "label.visibility.private": { zh: "私有", en: "private" },
  "label.visibility.public": { zh: "公开", en: "public" },
};
