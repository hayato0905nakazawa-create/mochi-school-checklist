import { createClient } from "npm:@supabase/supabase-js@2.58.0";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const secretMap = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const SERVICE_KEY = secretMap.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SERVICE_KEY) throw new Error("Supabase secret key is missing");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") || "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") || "";
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const enc = new TextEncoder();
const SESSION_DAYS = 30;
const allowedOrigins = new Set([
  "https://mochi-hayato.onrender.com",
  "http://localhost:3000",
]);
function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = allowedOrigins.has(origin)
    ? origin
    : "https://mochi-hayato.onrender.com";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Vary": "Origin",
  };
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(req) },
  });
}
function cleanUsername(v: unknown) {
  return String(v || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24);
}
function cleanText(v: unknown) {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, 80);
}
function validDate(v: unknown) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
}
function validTime(v: unknown) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
}
function toHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(s: string) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function pinHash(pin: string, saltHex?: string) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 120000, hash: "SHA-256" },
    material,
    256,
  );
  return { salt: toHex(salt), hash: toHex(new Uint8Array(bits)) };
}
function safeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function sha256Hex(value: string) {
  const bits = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return toHex(new Uint8Array(bits));
}
async function createSession(userId: string) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  const { error } = await admin.from("mochi_sessions").insert({
    token_hash: tokenHash,
    user_id: userId,
    expires_at: expiresAt,
  });
  if (error) throw error;
  return token;
}
async function getAuth(req: Request) {
  const raw = req.headers.get("authorization") || "";
  if (!raw.startsWith("Bearer ")) return null;
  const token = raw.slice(7).trim();
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const { data: session, error } = await admin
    .from("mochi_sessions")
    .select("user_id,expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error || !session) return null;
  if (Date.parse(session.expires_at) <= Date.now()) {
    await admin.from("mochi_sessions").delete().eq("token_hash", tokenHash);
    return null;
  }
  const { data: user } = await admin
    .from("mochi_users")
    .select("id,username")
    .eq("id", session.user_id)
    .maybeSingle();
  if (!user) return null;
  return { user, tokenHash };
}
function taskOut(t: any) {
  return {
    id: t.id,
    text: t.text,
    date: t.task_date,
    time: String(t.task_time).slice(0, 5),
    done: t.done,
    notifiedAt: t.notified_at,
    createdAt: t.created_at,
  };
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const url = new URL(req.url);
  const marker = "/api";
  const pos = url.pathname.lastIndexOf(marker);
  const route = (pos >= 0 ? url.pathname.slice(pos + marker.length) : url.pathname) || "/";

  try {
    if (req.method === "GET" && route === "/status") {
      const { count, error } = await admin.from("mochi_users").select("id", { count: "exact", head: true });
      if (error) throw error;
      return json(req, { hasUsers: (count || 0) > 0, signupOpen: (count || 0) === 0 });
    }

    if (req.method === "POST" && route === "/register") {
      const body = await req.json();
      const username = cleanUsername(body.username);
      const pin = String(body.pin || "");
      if (username.length < 3) return json(req, { error: "IDは3文字以上にしてください" }, 400);
      if (!/^\d{4,8}$/.test(pin)) return json(req, { error: "PINは4〜8桁の数字にしてください" }, 400);
      const { count } = await admin.from("mochi_users").select("id", { count: "exact", head: true });
      if ((count || 0) > 0) return json(req, { error: "初回設定は完了しています" }, 403);
      const hp = await pinHash(pin);
      const { data: user, error } = await admin.from("mochi_users").insert({
        username,
        pin_salt: hp.salt,
        pin_hash: hp.hash,
      }).select("id,username").single();
      if (error) {
        if (error.code === "23505") return json(req, { error: "そのIDは使われています" }, 409);
        throw error;
      }
      const token = await createSession(user.id);
      return json(req, { ok: true, username: user.username, token });
    }

    if (req.method === "POST" && route === "/login") {
      const body = await req.json();
      const username = cleanUsername(body.username);
      const pin = String(body.pin || "");
      const { data: user } = await admin.from("mochi_users")
        .select("id,username,pin_salt,pin_hash").eq("username", username).maybeSingle();
      if (!user) return json(req, { error: "IDまたはPINが違います" }, 401);
      const hp = await pinHash(pin, user.pin_salt);
      if (!safeEqualHex(hp.hash, user.pin_hash)) return json(req, { error: "IDまたはPINが違います" }, 401);
      const token = await createSession(user.id);
      return json(req, { ok: true, username: user.username, token });
    }

    const auth = await getAuth(req);
    if (!auth) return json(req, { error: "ログインが必要です" }, 401);
    if (req.method === "POST" && route === "/logout") {
      await admin.from("mochi_sessions").delete().eq("token_hash", auth.tokenHash);
      return json(req, { ok: true });
    }
    if (req.method === "GET" && route === "/me") {
      return json(req, { username: auth.user.username });
    }

    if (req.method === "GET" && route === "/tasks") {
      const date = url.searchParams.get("date") || "";
      let q = admin.from("mochi_tasks")
        .select("id,text,task_date,task_time,done,notified_at,created_at")
        .eq("user_id", auth.user.id)
        .order("task_date").order("task_time").order("created_at");
      if (date) q = q.eq("task_date", date);
      const { data, error } = await q;
      if (error) throw error;
      return json(req, { tasks: (data || []).map(taskOut) });
    }

    if (req.method === "POST" && route === "/tasks") {
      const body = await req.json();
      const textValue = cleanText(body.text);
      const date = String(body.date || "");
      const time = String(body.time || "07:00");
      if (!textValue) return json(req, { error: "持ち物を入力してください" }, 400);
      if (!validDate(date)) return json(req, { error: "日付が正しくありません" }, 400);
      if (!validTime(time)) return json(req, { error: "時刻が正しくありません" }, 400);
      const { data, error } = await admin.from("mochi_tasks").insert({
        user_id: auth.user.id,
        text: textValue,
        task_date: date,
        task_time: time,
      }).select("id,text,task_date,task_time,done,notified_at,created_at").single();
      if (error) throw error;
      return json(req, { task: taskOut(data) });
    }

    const taskMatch = route.match(/^\/tasks\/([0-9a-f-]+)$/);
    if (taskMatch && req.method === "PATCH") {
      const body = await req.json();
      const update: Record<string, unknown> = {};
      if (typeof body.done === "boolean") update.done = body.done;
      if (body.text !== undefined) {
        const t = cleanText(body.text);
        if (!t) return json(req, { error: "持ち物を入力してください" }, 400);
        update.text = t;
      }
      if (body.date !== undefined) {
        if (!validDate(body.date)) return json(req, { error: "日付が正しくありません" }, 400);
        update.task_date = body.date; update.notified_at = null;
      }
      if (body.time !== undefined) {
        if (!validTime(body.time)) return json(req, { error: "時刻が正しくありません" }, 400);
        update.task_time = body.time; update.notified_at = null;
      }
      const { data, error } = await admin.from("mochi_tasks").update(update)
        .eq("id", taskMatch[1]).eq("user_id", auth.user.id)
        .select("id,text,task_date,task_time,done,notified_at,created_at").maybeSingle();
      if (error) throw error;
      if (!data) return json(req, { error: "見つかりません" }, 404);
      return json(req, { task: taskOut(data) });
    }

    if (taskMatch && req.method === "DELETE") {
      const { data, error } = await admin.from("mochi_tasks").delete()
        .eq("id", taskMatch[1]).eq("user_id", auth.user.id).select("id");
      if (error) throw error;
      if (!data?.length) return json(req, { error: "見つかりません" }, 404);
      return json(req, { ok: true });
    }

    if (req.method === "GET" && route === "/push/public-key") {
      if (!VAPID_PUBLIC_KEY) return json(req, { error: "通知設定が未完了です" }, 503);
      return json(req, { publicKey: VAPID_PUBLIC_KEY });
    }
    if (req.method === "POST" && route === "/push/subscribe") {
      const body = await req.json();
      const sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys) return json(req, { error: "通知登録に失敗しました" }, 400);
      const { error } = await admin.from("mochi_subscriptions").upsert({
        user_id: auth.user.id,
        endpoint: sub.endpoint,
        subscription: sub,
      }, { onConflict: "endpoint" });
      if (error) throw error;
      return json(req, { ok: true });
    }

    if (req.method === "DELETE" && route === "/push/subscribe") {
      const body = await req.json();
      const endpoint = String(body.endpoint || "");
      const { error } = await admin.from("mochi_subscriptions").delete()
        .eq("user_id", auth.user.id).eq("endpoint", endpoint);
      if (error) throw error;
      return json(req, { ok: true });
    }

    if (req.method === "POST" && route === "/push/test") {
      if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return json(req, { error: "通知設定が未完了です" }, 503);
      const { data: subs, error } = await admin.from("mochi_subscriptions")
        .select("id,subscription").eq("user_id", auth.user.id);
      if (error) throw error;
      if (!subs?.length) return json(req, { error: "通知先が登録されていません" }, 400);
      let sent = 0;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(sub.subscription as any, JSON.stringify({
            title: "Mochi 通知テスト",
            body: "通知テスト成功！",
            taskId: "test-" + Date.now(),
          }));
          sent++;
        } catch (err: any) {
          console.error("push test error", err?.statusCode || "", err?.message || err);
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await admin.from("mochi_subscriptions").delete().eq("id", sub.id);
          }
        }
      }
      if (!sent) return json(req, { error: "通知送信に失敗しました" }, 502);
      return json(req, { ok: true, sent });
    }

    return json(req, { error: "見つかりません" }, 404);
  } catch (err) {
    console.error(err);
    return json(req, { error: "サーバーエラーが発生しました" }, 500);
  }
});
