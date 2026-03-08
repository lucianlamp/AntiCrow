var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// functions/api/waitlist/register.ts
function generateReferralCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "AC-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
__name(generateReferralCode, "generateReferralCode");
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
__name(isValidEmail, "isValidEmail");
var onRequestPost = /* @__PURE__ */ __name(async (context) => {
  const { DB } = context.env;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
  try {
    const body = await context.request.json();
    const { email, referralCode } = body;
    if (!email || !isValidEmail(email)) {
      return new Response(
        JSON.stringify({ error: "Valid email is required" }),
        { status: 400, headers: corsHeaders }
      );
    }
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await DB.prepare(
      "SELECT id, referral_code, position, referral_count, priority_score FROM waitlist WHERE email = ?"
    ).bind(normalizedEmail).first();
    if (existing) {
      const totalCount = await DB.prepare("SELECT COUNT(*) as total FROM waitlist").first();
      const effectivePosition = Math.max(1, existing.position - existing.priority_score);
      const points = existing.referral_count * 10;
      return new Response(
        JSON.stringify({
          success: true,
          alreadyRegistered: true,
          email: normalizedEmail,
          referralCode: existing.referral_code,
          position: effectivePosition,
          totalCount: totalCount?.total || 0,
          points,
          pointsLabel: `${points}pt`,
          referralLink: `https://anticrow.pages.dev?ref=${existing.referral_code}`
        }),
        { status: 200, headers: corsHeaders }
      );
    }
    let newReferralCode = generateReferralCode();
    let attempts = 0;
    while (attempts < 10) {
      const codeExists = await DB.prepare(
        "SELECT id FROM waitlist WHERE referral_code = ?"
      ).bind(newReferralCode).first();
      if (!codeExists) break;
      newReferralCode = generateReferralCode();
      attempts++;
    }
    const maxPosition = await DB.prepare(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM waitlist"
    ).first();
    const nextPosition = (maxPosition?.max_pos || 0) + 1;
    let referredBy = null;
    if (referralCode) {
      const referrer = await DB.prepare(
        "SELECT id, referral_code FROM waitlist WHERE referral_code = ?"
      ).bind(referralCode).first();
      if (referrer) {
        referredBy = referralCode;
        await DB.prepare(
          "UPDATE waitlist SET referral_count = referral_count + 1, priority_score = priority_score + 5 WHERE referral_code = ?"
        ).bind(referralCode).run();
      }
    }
    await DB.prepare(
      "INSERT INTO waitlist (email, referral_code, referred_by, referral_count, position, priority_score, email_verified) VALUES (?, ?, ?, 0, ?, 0, 0)"
    ).bind(normalizedEmail, newReferralCode, referredBy, nextPosition).run();
    return new Response(
      JSON.stringify({
        success: true,
        alreadyRegistered: false,
        email: normalizedEmail,
        referralCode: newReferralCode,
        position: nextPosition,
        totalCount: nextPosition,
        points: 0,
        pointsLabel: "0pt",
        referralLink: `https://anticrow.pages.dev?ref=${newReferralCode}`
      }),
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Registration error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestPost");
var onRequestOptions = /* @__PURE__ */ __name(async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}, "onRequestOptions");

// functions/api/waitlist/status.ts
var onRequestGet = /* @__PURE__ */ __name(async (context) => {
  const { DB } = context.env;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
  try {
    const url = new URL(context.request.url);
    const email = url.searchParams.get("email");
    if (!email) {
      return new Response(
        JSON.stringify({ error: "Email parameter is required" }),
        { status: 400, headers: corsHeaders }
      );
    }
    const normalizedEmail = email.toLowerCase().trim();
    const user = await DB.prepare(
      "SELECT email, referral_code, referred_by, referral_count, position, priority_score, email_verified, created_at FROM waitlist WHERE email = ?"
    ).bind(normalizedEmail).first();
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Email not found in waitlist" }),
        { status: 404, headers: corsHeaders }
      );
    }
    const totalCount = await DB.prepare(
      "SELECT COUNT(*) as total FROM waitlist"
    ).first();
    const effectivePosition = Math.max(1, user.position - user.priority_score);
    const points = user.referral_count * 10;
    return new Response(
      JSON.stringify({
        email: user.email,
        referralCode: user.referral_code,
        position: effectivePosition,
        totalCount: totalCount?.total || 0,
        points,
        pointsLabel: `${points}pt`,
        emailVerified: user.email_verified === 1,
        createdAt: user.created_at,
        referralLink: `https://anticrow.pages.dev?ref=${user.referral_code}`
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Status error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestGet");
var onRequestOptions2 = /* @__PURE__ */ __name(async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}, "onRequestOptions");

// ../shared/utils.ts
function generateToken(length = 48) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  let token = "";
  for (let i = 0; i < length; i++) {
    token += chars.charAt(randomValues[i] % chars.length);
  }
  return token;
}
__name(generateToken, "generateToken");
async function sendEmailsInChunks(items, sendFn, chunkSize = 10) {
  const results = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.allSettled(chunk.map(sendFn));
    for (const result of chunkResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({ success: false, error: result.reason?.message || "Unknown error" });
      }
    }
  }
  return results;
}
__name(sendEmailsInChunks, "sendEmailsInChunks");

// ../shared/email-templates.ts
function generateInviteEmailHtml(params) {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#111;border-radius:16px;overflow:hidden;border:1px solid #222">
  <tr><td style="padding:40px 40px 20px;text-align:center">
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">\u{1F985} Anti-Crow</div>
    <div style="font-size:13px;color:#888;margin-top:4px">AI-Powered Development Assistant</div>
  </td></tr>
  <tr><td style="padding:20px 40px">
    <h1 style="color:#fff;font-size:22px;margin:0 0 16px">\u30A6\u30A7\u30A4\u30C8\u30EA\u30B9\u30C8\u304B\u3089\u62DB\u5F85\u3055\u308C\u307E\u3057\u305F\uFF01\u{1F389}</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      Anti-Crow \u3078\u306E\u30A2\u30AF\u30BB\u30B9\u304C\u627F\u8A8D\u3055\u308C\u307E\u3057\u305F\u3002\u4EE5\u4E0B\u306E\u30DC\u30BF\u30F3\u304B\u3089VSIX\u62E1\u5F35\u6A5F\u80FD\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3057\u3066\u304F\u3060\u3055\u3044\u3002
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${params.downloadUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:0.3px">
        \u2B07\uFE0F Anti-Crow v${params.version} \u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9
      </a>
    </div>
    <p style="color:#666;font-size:13px;text-align:center;margin:0 0 24px">
      \u23F0 \u3053\u306E\u30EA\u30F3\u30AF\u306F${params.expiresIn}\u6709\u52B9\u3067\u3059
    </p>
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">\u{1F4E6} \u30BB\u30C3\u30C8\u30A2\u30C3\u30D7\u624B\u9806</h3>
      <ol style="color:#aaa;font-size:13px;line-height:1.8;margin:0;padding-left:20px">
        <li>\u4E0A\u306E\u30DC\u30BF\u30F3\u304B\u3089 .vsix \u30D5\u30A1\u30A4\u30EB\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9</li>
        <li>VS Code / Antigravity \u3067 <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">\u62E1\u5F35\u6A5F\u80FD</code> \u2192 <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">...</code> \u2192 <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">VSIX\u304B\u3089\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB</code></li>
        <li>\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3057\u305F .vsix \u30D5\u30A1\u30A4\u30EB\u3092\u9078\u629E\u3057\u3066\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB</li>
      </ol>
    </div>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #222">
    <p style="color:#555;font-size:12px;text-align:center;margin:0">
      Anti-Crow Team \u2014 \u3053\u306E\u30E1\u30FC\u30EB\u306F\u30A6\u30A7\u30A4\u30C8\u30EA\u30B9\u30C8\u767B\u9332\u306B\u57FA\u3065\u3044\u3066\u9001\u4FE1\u3055\u308C\u3066\u3044\u307E\u3059
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
__name(generateInviteEmailHtml, "generateInviteEmailHtml");
function generateUpdateEmailHtml(params) {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#111;border-radius:16px;overflow:hidden;border:1px solid #222">
  <tr><td style="padding:40px 40px 20px;text-align:center">
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px">\u{1F985} Anti-Crow</div>
    <div style="font-size:13px;color:#888;margin-top:4px">AI-Powered Development Assistant</div>
  </td></tr>
  <tr><td style="padding:20px 40px">
    <h1 style="color:#fff;font-size:22px;margin:0 0 16px">\u65B0\u30D0\u30FC\u30B8\u30E7\u30F3 v${params.version} \u304C\u30EA\u30EA\u30FC\u30B9\u3055\u308C\u307E\u3057\u305F\uFF01\u{1F680}</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      Anti-Crow \u306E\u6700\u65B0\u30D0\u30FC\u30B8\u30E7\u30F3\u304C\u30EA\u30EA\u30FC\u30B9\u3055\u308C\u307E\u3057\u305F\u3002\u4EE5\u4E0B\u304B\u3089\u6700\u65B0\u7248\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3057\u3066\u304F\u3060\u3055\u3044\u3002
    </p>
    <div style="text-align:center;margin:32px 0">
      <a href="${params.downloadUrl}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:12px;font-size:16px;font-weight:700;letter-spacing:0.3px">
        \u2B07\uFE0F v${params.version} \u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9
      </a>
    </div>
    <p style="color:#666;font-size:13px;text-align:center;margin:0 0 24px">
      \u23F0 \u3053\u306E\u30EA\u30F3\u30AF\u306F${params.expiresIn}\u6709\u52B9\u3067\u3059
    </p>
    ${params.changelog ? `
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 12px">\u{1F4CB} \u5909\u66F4\u70B9</h3>
      <div style="color:#aaa;font-size:13px;line-height:1.8;white-space:pre-line">${params.changelog}</div>
    </div>` : ""}
    <div style="background:#1a1a2e;border-radius:12px;padding:20px;margin-top:16px;border:1px solid #2a2a4a">
      <h3 style="color:#fff;font-size:14px;margin:0 0 8px">\u{1F4A1} \u30A2\u30C3\u30D7\u30C7\u30FC\u30C8\u65B9\u6CD5</h3>
      <p style="color:#aaa;font-size:13px;margin:0">
        Discord \u3067 <code style="background:#222;padding:2px 6px;border-radius:4px;color:#a78bfa">/update</code> \u30B3\u30DE\u30F3\u30C9\u3092\u5B9F\u884C\u3059\u308B\u304B\u3001\u4E0A\u306E\u30DC\u30BF\u30F3\u304B\u3089\u624B\u52D5\u3067\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u3057\u3066\u30A4\u30F3\u30B9\u30C8\u30FC\u30EB\u3057\u3066\u304F\u3060\u3055\u3044\u3002
      </p>
    </div>
  </td></tr>
  <tr><td style="padding:24px 40px;border-top:1px solid #222">
    <p style="color:#555;font-size:12px;text-align:center;margin:0">
      Anti-Crow Team \u2014 \u3053\u306E\u30E1\u30FC\u30EB\u306F\u30A6\u30A7\u30A4\u30C8\u30EA\u30B9\u30C8\u767B\u9332\u306B\u57FA\u3065\u3044\u3066\u9001\u4FE1\u3055\u308C\u3066\u3044\u307E\u3059
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
__name(generateUpdateEmailHtml, "generateUpdateEmailHtml");

// api/admin/invite.ts
var onRequestPost2 = /* @__PURE__ */ __name(async (context) => {
  const { DB, RESEND_API_KEY } = context.env;
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    const body = await context.request.json();
    const { emails } = body;
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return new Response(
        JSON.stringify({ error: "emails array is required" }),
        { status: 400, headers: corsHeaders }
      );
    }
    const latestRelease = await DB.prepare(
      "SELECT version, r2_key FROM releases WHERE is_latest = 1 LIMIT 1"
    ).first();
    if (!latestRelease) {
      return new Response(
        JSON.stringify({ error: "No release available. Upload a VSIX first." }),
        { status: 400, headers: corsHeaders }
      );
    }
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
    const results = await sendEmailsInChunks(emails, async (email) => {
      const token = generateToken();
      const downloadUrl = `https://anticrow.pages.dev/api/download/${token}`;
      await DB.prepare(
        "INSERT INTO invite_logs (email, version, download_token, token_expires_at, status) VALUES (?, ?, ?, ?, ?)"
      ).bind(email, latestRelease.version, token, expiresAt, "sent").run();
      const emailHtml = generateInviteEmailHtml({
        downloadUrl,
        version: latestRelease.version,
        expiresIn: "24\u6642\u9593"
      });
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Anti-Crow <onboarding@resend.dev>",
          to: email,
          subject: "\u{1F985} Anti-Crow \u3078\u3088\u3046\u3053\u305D\uFF01\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u30EA\u30F3\u30AF\u3092\u304A\u5C4A\u3051\u3057\u307E\u3059",
          html: emailHtml
        })
      });
      if (!resendRes.ok) {
        const errBody = await resendRes.text();
        throw new Error(`Resend API error: ${resendRes.status} ${errBody}`);
      }
      await DB.prepare(
        "UPDATE waitlist SET invite_status = 'invited', invited_at = datetime('now') WHERE email = ?"
      ).bind(email).run();
      return { success: true };
    });
    const successCount = results.filter((r) => r.success).length;
    return new Response(
      JSON.stringify({ results: results.map((r, i) => ({ email: emails[i], ...r })), successCount, totalCount: emails.length }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Invite error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestPost");

// api/admin/notify-update.ts
var onRequestPost3 = /* @__PURE__ */ __name(async (context) => {
  const { DB, RESEND_API_KEY } = context.env;
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    const latestRelease = await DB.prepare(
      "SELECT version, r2_key, changelog FROM releases WHERE is_latest = 1 LIMIT 1"
    ).first();
    if (!latestRelease) {
      return new Response(
        JSON.stringify({ error: "No release available" }),
        { status: 400, headers: corsHeaders }
      );
    }
    const users = await DB.prepare(
      "SELECT email FROM waitlist WHERE invite_status = 'invited' AND (current_version IS NULL OR current_version != ?)"
    ).bind(latestRelease.version).all();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
    const results = await sendEmailsInChunks(users.results, async (user) => {
      const token = generateToken();
      const downloadUrl = `https://anticrow.pages.dev/api/download/${token}`;
      await DB.prepare(
        "INSERT INTO invite_logs (email, version, download_token, token_expires_at, status) VALUES (?, ?, ?, ?, ?)"
      ).bind(user.email, latestRelease.version, token, expiresAt, "sent").run();
      const emailHtml = generateUpdateEmailHtml({
        downloadUrl,
        version: latestRelease.version,
        changelog: latestRelease.changelog || "",
        expiresIn: "24\u6642\u9593"
      });
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: "Anti-Crow <onboarding@resend.dev>",
          to: user.email,
          subject: `\u{1F680} Anti-Crow v${latestRelease.version} \u304C\u30EA\u30EA\u30FC\u30B9\u3055\u308C\u307E\u3057\u305F\uFF01`,
          html: emailHtml
        })
      });
      if (!resendRes.ok) {
        const errBody = await resendRes.text();
        throw new Error(`Resend API error: ${resendRes.status} ${errBody}`);
      }
      return { success: true };
    });
    const successCount = results.filter((r) => r.success).length;
    return new Response(
      JSON.stringify({ results: results.map((r, i) => ({ email: users.results[i].email, ...r })), successCount, totalCount: users.results.length }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Notify update error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestPost");

// api/admin/releases.ts
var onRequestGet2 = /* @__PURE__ */ __name(async (context) => {
  const { DB } = context.env;
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    const releases = await DB.prepare(
      "SELECT id, version, r2_key, changelog, download_count, created_at, is_latest FROM releases ORDER BY created_at DESC"
    ).all();
    return new Response(
      JSON.stringify({ releases: releases.results }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Releases list error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestGet");
var onRequestPost4 = /* @__PURE__ */ __name(async (context) => {
  const { DB, R2 } = context.env;
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    const formData = await context.request.formData();
    const file = formData.get("file");
    const version = formData.get("version");
    const changelog = formData.get("changelog");
    if (!file || !version) {
      return new Response(
        JSON.stringify({ error: "file and version are required" }),
        { status: 400, headers: corsHeaders }
      );
    }
    const existing = await DB.prepare(
      "SELECT id FROM releases WHERE version = ?"
    ).bind(version).first();
    if (existing) {
      return new Response(
        JSON.stringify({ error: `Version ${version} already exists` }),
        { status: 409, headers: corsHeaders }
      );
    }
    const r2Key = `releases/anti-crow-${version}.vsix`;
    await DB.prepare("UPDATE releases SET is_latest = 0 WHERE is_latest = 1").run();
    await DB.prepare(
      "INSERT INTO releases (version, r2_key, changelog, is_latest) VALUES (?, ?, ?, 1)"
    ).bind(version, r2Key, changelog || "").run();
    try {
      const fileBuffer = await file.arrayBuffer();
      await R2.put(r2Key, fileBuffer, {
        httpMetadata: {
          contentType: "application/octet-stream",
          contentDisposition: `attachment; filename="anti-crow-${version}.vsix"`
        }
      });
    } catch (r2Error) {
      await DB.prepare("DELETE FROM releases WHERE version = ?").bind(version).run();
      throw r2Error;
    }
    return new Response(
      JSON.stringify({ success: true, version, r2Key }),
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Release upload error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestPost");

// api/admin/stats.ts
var onRequestGet3 = /* @__PURE__ */ __name(async (context) => {
  const { DB } = context.env;
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    const [total, pending, invited, downloaded, totalDownloads] = await Promise.all([
      DB.prepare("SELECT COUNT(*) as count FROM waitlist").first(),
      DB.prepare("SELECT COUNT(*) as count FROM waitlist WHERE invite_status = 'pending' OR invite_status IS NULL").first(),
      DB.prepare("SELECT COUNT(*) as count FROM waitlist WHERE invite_status = 'invited'").first(),
      DB.prepare("SELECT COUNT(*) as count FROM waitlist WHERE invite_status = 'downloaded'").first(),
      DB.prepare("SELECT COALESCE(SUM(download_count), 0) as count FROM releases").first()
    ]);
    const recentRegistrations = await DB.prepare(
      `SELECT date(created_at) as date, COUNT(*) as count
       FROM waitlist
       WHERE created_at >= datetime('now', '-7 days')
       GROUP BY date(created_at)
       ORDER BY date ASC`
    ).all();
    const recentEmails = await DB.prepare(
      "SELECT COUNT(*) as count FROM invite_logs WHERE sent_at >= datetime('now', '-7 days')"
    ).first();
    return new Response(
      JSON.stringify({
        totalUsers: total?.count || 0,
        pendingUsers: pending?.count || 0,
        invitedUsers: invited?.count || 0,
        downloadedUsers: downloaded?.count || 0,
        totalDownloads: totalDownloads?.count || 0,
        recentEmails: recentEmails?.count || 0,
        registrationTrend: recentRegistrations.results
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Stats error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestGet");

// api/admin/users.ts
var onRequestGet4 = /* @__PURE__ */ __name(async (context) => {
  const { DB } = context.env;
  const url = new URL(context.request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const status = url.searchParams.get("status") || "all";
  const search = url.searchParams.get("search") || "";
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  try {
    let whereClause = "";
    const params = [];
    if (status !== "all") {
      if (status === "pending") {
        whereClause = "WHERE (invite_status = 'pending' OR invite_status IS NULL)";
      } else {
        whereClause = "WHERE invite_status = ?";
        params.push(status);
      }
    }
    if (search) {
      whereClause += whereClause ? " AND email LIKE ?" : "WHERE email LIKE ?";
      params.push(`%${search}%`);
    }
    const offset = (page - 1) * limit;
    const countQuery = await DB.prepare(
      `SELECT COUNT(*) as total FROM waitlist ${whereClause}`
    ).bind(...params).first();
    const users = await DB.prepare(
      `SELECT * FROM waitlist ${whereClause} ORDER BY priority_score DESC, created_at ASC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();
    return new Response(
      JSON.stringify({ users: users.results, total: countQuery?.total || 0 }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Users list error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestGet");

// api/waitlist/register.ts
function generateReferralCode2() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "AC-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}
__name(generateReferralCode2, "generateReferralCode");
function isValidEmail2(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
__name(isValidEmail2, "isValidEmail");
var onRequestPost5 = /* @__PURE__ */ __name(async (context) => {
  const { DB } = context.env;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
  try {
    const body = await context.request.json();
    const { email, referralCode } = body;
    if (!email || !isValidEmail2(email)) {
      return new Response(
        JSON.stringify({ error: "Valid email is required" }),
        { status: 400, headers: corsHeaders }
      );
    }
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await DB.prepare(
      "SELECT id, referral_code, position, referral_count, priority_score FROM waitlist WHERE email = ?"
    ).bind(normalizedEmail).first();
    if (existing) {
      const totalCount = await DB.prepare("SELECT COUNT(*) as total FROM waitlist").first();
      const effectivePosition = Math.max(1, existing.position - existing.priority_score);
      const points = existing.referral_count * 10;
      return new Response(
        JSON.stringify({
          success: true,
          alreadyRegistered: true,
          email: normalizedEmail,
          referralCode: existing.referral_code,
          position: effectivePosition,
          totalCount: totalCount?.total || 0,
          points,
          pointsLabel: `${points}pt`,
          referralLink: `https://anticrow.pages.dev?ref=${existing.referral_code}`
        }),
        { status: 200, headers: corsHeaders }
      );
    }
    let newReferralCode = generateReferralCode2();
    let attempts = 0;
    while (attempts < 10) {
      const codeExists = await DB.prepare(
        "SELECT id FROM waitlist WHERE referral_code = ?"
      ).bind(newReferralCode).first();
      if (!codeExists) break;
      newReferralCode = generateReferralCode2();
      attempts++;
    }
    const maxPosition = await DB.prepare(
      "SELECT COALESCE(MAX(position), 0) as max_pos FROM waitlist"
    ).first();
    const nextPosition = (maxPosition?.max_pos || 0) + 1;
    let referredBy = null;
    if (referralCode) {
      const referrer = await DB.prepare(
        "SELECT id, referral_code FROM waitlist WHERE referral_code = ?"
      ).bind(referralCode).first();
      if (referrer) {
        referredBy = referralCode;
        await DB.prepare(
          "UPDATE waitlist SET referral_count = referral_count + 1, priority_score = priority_score + 5 WHERE referral_code = ?"
        ).bind(referralCode).run();
      }
    }
    await DB.prepare(
      "INSERT INTO waitlist (email, referral_code, referred_by, referral_count, position, priority_score, email_verified) VALUES (?, ?, ?, 0, ?, 0, 0)"
    ).bind(normalizedEmail, newReferralCode, referredBy, nextPosition).run();
    return new Response(
      JSON.stringify({
        success: true,
        alreadyRegistered: false,
        email: normalizedEmail,
        referralCode: newReferralCode,
        position: nextPosition,
        totalCount: nextPosition,
        points: 0,
        pointsLabel: "0pt",
        referralLink: `https://anticrow.pages.dev?ref=${newReferralCode}`
      }),
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Registration error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestPost");
var onRequestOptions3 = /* @__PURE__ */ __name(async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}, "onRequestOptions");

// api/waitlist/status.ts
var onRequestGet5 = /* @__PURE__ */ __name(async (context) => {
  const { DB } = context.env;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
  try {
    const url = new URL(context.request.url);
    const email = url.searchParams.get("email");
    if (!email) {
      return new Response(
        JSON.stringify({ error: "Email parameter is required" }),
        { status: 400, headers: corsHeaders }
      );
    }
    const normalizedEmail = email.toLowerCase().trim();
    const user = await DB.prepare(
      "SELECT email, referral_code, referred_by, referral_count, position, priority_score, email_verified, created_at FROM waitlist WHERE email = ?"
    ).bind(normalizedEmail).first();
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Email not found in waitlist" }),
        { status: 404, headers: corsHeaders }
      );
    }
    const totalCount = await DB.prepare(
      "SELECT COUNT(*) as total FROM waitlist"
    ).first();
    const effectivePosition = Math.max(1, user.position - user.priority_score);
    const points = user.referral_count * 10;
    return new Response(
      JSON.stringify({
        email: user.email,
        referralCode: user.referral_code,
        position: effectivePosition,
        totalCount: totalCount?.total || 0,
        points,
        pointsLabel: `${points}pt`,
        emailVerified: user.email_verified === 1,
        createdAt: user.created_at,
        referralLink: `https://anticrow.pages.dev?ref=${user.referral_code}`
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (error) {
    console.error("Status error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
}, "onRequestGet");
var onRequestOptions4 = /* @__PURE__ */ __name(async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}, "onRequestOptions");

// api/download/[token].ts
var onRequestGet6 = /* @__PURE__ */ __name(async (context) => {
  const { DB, R2 } = context.env;
  const token = context.params.token;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*"
  };
  try {
    if (!token) {
      return new Response("Invalid token", { status: 400, headers: corsHeaders });
    }
    const inviteLog = await DB.prepare(
      "SELECT id, email, version, token_expires_at, downloaded_at FROM invite_logs WHERE download_token = ?"
    ).bind(token).first();
    if (!inviteLog) {
      return new Response(
        '<html><body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h1>\u274C \u7121\u52B9\u306A\u30EA\u30F3\u30AF</h1><p style="color:#888">\u3053\u306E\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u30EA\u30F3\u30AF\u306F\u7121\u52B9\u3067\u3059\u3002</p></div></body></html>',
        { status: 404, headers: { "Content-Type": "text/html", ...corsHeaders } }
      );
    }
    if (inviteLog.downloaded_at) {
      return new Response(
        '<html><body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h1>\u2705 \u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u6E08\u307F</h1><p style="color:#888">\u3053\u306E\u30EA\u30F3\u30AF\u306F\u65E2\u306B\u4F7F\u7528\u3055\u308C\u3066\u3044\u307E\u3059\u3002\u65B0\u3057\u3044\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u30EA\u30F3\u30AF\u304C\u5FC5\u8981\u306A\u5834\u5408\u306F\u3001\u7BA1\u7406\u8005\u306B\u304A\u554F\u3044\u5408\u308F\u305B\u304F\u3060\u3055\u3044\u3002</p></div></body></html>',
        { status: 410, headers: { "Content-Type": "text/html", ...corsHeaders } }
      );
    }
    const now = /* @__PURE__ */ new Date();
    const expiresAt = new Date(inviteLog.token_expires_at);
    if (now > expiresAt) {
      return new Response(
        '<html><body style="background:#0a0a0a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h1>\u23F0 \u30EA\u30F3\u30AF\u671F\u9650\u5207\u308C</h1><p style="color:#888">\u3053\u306E\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u30EA\u30F3\u30AF\u306F\u671F\u9650\u5207\u308C\u3067\u3059\u3002\u7BA1\u7406\u8005\u306B\u65B0\u3057\u3044\u30EA\u30F3\u30AF\u3092\u30EA\u30AF\u30A8\u30B9\u30C8\u3057\u3066\u304F\u3060\u3055\u3044\u3002</p></div></body></html>',
        { status: 410, headers: { "Content-Type": "text/html", ...corsHeaders } }
      );
    }
    const release = await DB.prepare(
      "SELECT r2_key FROM releases WHERE version = ?"
    ).bind(inviteLog.version).first();
    if (!release) {
      return new Response("Release not found", { status: 404, headers: corsHeaders });
    }
    const object = await R2.get(release.r2_key);
    if (!object) {
      return new Response("File not found in storage", { status: 404, headers: corsHeaders });
    }
    await DB.prepare(
      "UPDATE invite_logs SET downloaded_at = datetime('now'), status = 'downloaded' WHERE id = ?"
    ).bind(inviteLog.id).run();
    await DB.prepare(
      "UPDATE waitlist SET invite_status = 'downloaded', current_version = ? WHERE email = ?"
    ).bind(inviteLog.version, inviteLog.email).run();
    await DB.prepare(
      "UPDATE releases SET download_count = download_count + 1 WHERE version = ?"
    ).bind(inviteLog.version).run();
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="anti-crow-${inviteLog.version}.vsix"`,
        "Content-Length": object.size.toString(),
        ...corsHeaders
      }
    });
  } catch (error) {
    console.error("Download error:", error);
    return new Response("Internal server error", { status: 500, headers: corsHeaders });
  }
}, "onRequestGet");

// api/admin/_middleware.ts
var onRequest = /* @__PURE__ */ __name(async (context) => {
  const { request, env } = context;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
  }
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Authorization required" }),
      {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      }
    );
  }
  const apiKey = authHeader.slice(7);
  if (apiKey !== env.ADMIN_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Invalid API key" }),
      {
        status: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      }
    );
  }
  return context.next();
}, "onRequest");

// ../.wrangler/tmp/pages-rip61e/functionsRoutes-0.8143456318796618.mjs
var routes = [
  {
    routePath: "/functions/api/waitlist/register",
    mountPath: "/functions/api/waitlist",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions]
  },
  {
    routePath: "/functions/api/waitlist/register",
    mountPath: "/functions/api/waitlist",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  },
  {
    routePath: "/functions/api/waitlist/status",
    mountPath: "/functions/api/waitlist",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/functions/api/waitlist/status",
    mountPath: "/functions/api/waitlist",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions2]
  },
  {
    routePath: "/api/admin/invite",
    mountPath: "/api/admin",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost2]
  },
  {
    routePath: "/api/admin/notify-update",
    mountPath: "/api/admin",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost3]
  },
  {
    routePath: "/api/admin/releases",
    mountPath: "/api/admin",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/api/admin/releases",
    mountPath: "/api/admin",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost4]
  },
  {
    routePath: "/api/admin/stats",
    mountPath: "/api/admin",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet3]
  },
  {
    routePath: "/api/admin/users",
    mountPath: "/api/admin",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet4]
  },
  {
    routePath: "/api/waitlist/register",
    mountPath: "/api/waitlist",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions3]
  },
  {
    routePath: "/api/waitlist/register",
    mountPath: "/api/waitlist",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost5]
  },
  {
    routePath: "/api/waitlist/status",
    mountPath: "/api/waitlist",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet5]
  },
  {
    routePath: "/api/waitlist/status",
    mountPath: "/api/waitlist",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions4]
  },
  {
    routePath: "/api/download/:token",
    mountPath: "/api/download",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet6]
  },
  {
    routePath: "/api/admin",
    mountPath: "/api/admin",
    method: "",
    middlewares: [onRequest],
    modules: []
  }
];

// ../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
