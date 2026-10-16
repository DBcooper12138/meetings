/* ============================================================
 *  会议发布与参会确认系统 —— 配置
 *  ★ 唯一需要你手改的文件就是这里。改完保存、重新上传即可。
 * ============================================================ */
window.MS_CONFIG = {
  /* 1) Supabase 项目地址
        ⚠ 只填域名，不要带多余的 https://，也不要带结尾的 /rest/v1/
        正确：https://abcdefghijk.supabase.co
        错误：https://https://abcdefghijk.supabase.co/rest/v1/

        位置：Supabase 控制台 -> Project Settings -> Data API -> Project URL
        （从控制台复制过来的原文通常就是对的，别再手工拼） */
  SUPABASE_URL: 'https://rgyjjoqlmhhusvdueqom.supabase.co',

  /* 2) Supabase anon public 密钥（注意：不是 service_role，绝不能用后者）
        位置：Supabase 控制台 -> Project Settings -> API Keys -> anon public
        整串从 eyJ 开始，一个字符都不能少、不能有换行 */
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJneWpqb3FsbWhodXN2ZHVlcW9tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMzU5NTQsImV4cCI6MjEwNzcxMTk1NH0.5aA0dtvuYX8n4Jqp2zqN0-sDPPRv5JwEIBLZ91syNYE',

  /* 3) 后台口令：必须与你在 SQL 里执行 set_admin_secret('...') 时设的口令一致。
        留空也行 —— 那样每次打开后台会弹框要你输入。 */
  ADMIN_SECRET: '',

  /* 4) 系统标题（显示在页面左上角与二级网页顶部） */
  APP_NAME: '会议发布与参会确认系统',
  ORG_NAME: '天津仁爱学院',

  /* 5) 后台数据刷新间隔（毫秒）。30000 = 30 秒自动拉取一次最新回执 */
  AUTO_REFRESH_MS: 30000
};

/* ---------------- 以下不用改 ---------------- */

/* 这两项是否已经填好 */
window.MS_CONFIG_OK = function () {
  var c = window.MS_CONFIG || {};
  return {
    url: /^https:\/\/[^\s\/]+\.[^\s\/]+$/.test(String(c.SUPABASE_URL || '').trim().replace(/\/+$/, '')),
    key: String(c.SUPABASE_ANON_KEY || '').indexOf('在这里') < 0 &&
         String(c.SUPABASE_ANON_KEY || '').trim().length > 40
  };
};

window.MS_CONFIG_READY = function () {
  var r = window.MS_CONFIG_OK();
  return !!(r.url && r.key);
};
