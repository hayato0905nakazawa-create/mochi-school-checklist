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
const publishableMap = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
const PUBLISHABLE_KEY = publishableMap.default || Deno.env.get("SUPABASE_ANON_KEY") || "";

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function tokyoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((acc: Record<string, string>, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function isQuietTime(now: string, start: string, end: string) {
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

Deno.serve(async (req) => {
  const apiKey = req.headers.get("apikey") || "";
  if (!PUBLISHABLE_KEY || apiKey !== PUBLISHABLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response("Push keys missing", { status: 503 });
  }

  const now = tokyoParts();
  const nowMs = Date.now();
  try {
    const { data: candidates, error } = await admin
      .from("mochi_tasks")
      .select("id,user_id,text,task_date,task_time,notified_at")
      .eq("done", false)
      .lte("task_date", now.date)
      .order("task_date")
      .order("task_time");
    if (error) throw error;

    const userIds = [...new Set((candidates || []).map((task: any) => task.user_id))];
    const preferenceMap = new Map<string, any>();

    if (userIds.length) {
      const { data: preferences, error: preferenceError } = await admin
        .from("mochi_preferences")
        .select("user_id,reminder_interval_minutes,quiet_enabled,quiet_start,quiet_end")
        .in("user_id", userIds);
      if (preferenceError) throw preferenceError;
      for (const pref of preferences || []) preferenceMap.set(pref.user_id, pref);
    }

    const tasks = (candidates || []).filter((task: any) => {
      const pref = preferenceMap.get(task.user_id) || {
        reminder_interval_minutes: 5,
        quiet_enabled: false,
        quiet_start: "22:00",
        quiet_end: "06:00",
      };

      const quietStart = String(pref.quiet_start || "22:00").slice(0, 5);
      const quietEnd = String(pref.quiet_end || "06:00").slice(0, 5);
      if (pref.quiet_enabled && isQuietTime(now.time, quietStart, quietEnd)) return false;

      const taskTime = String(task.task_time).slice(0, 5);
      const hasReachedFirstReminder =
        task.task_date < now.date ||
        (task.task_date === now.date && taskTime <= now.time);
      if (!hasReachedFirstReminder) return false;

      if (!task.notified_at) return true;
      const intervalMinutes = Math.max(1, Math.min(1440, Number(pref.reminder_interval_minutes) || 5));
      const lastNotifiedMs = Date.parse(task.notified_at);
      return Number.isFinite(lastNotifiedMs) &&
        nowMs - lastNotifiedMs >= intervalMinutes * 60 * 1000;
    });

    let deliveredTasks = 0;
    let sentPushes = 0;
    for (const task of tasks || []) {
      const { data: subs, error: subError } = await admin
        .from("mochi_subscriptions")
        .select("id,subscription")
        .eq("user_id", task.user_id);
      if (subError) throw subError;

      let delivered = false;
      for (const sub of subs || []) {
        try {
          await webpush.sendNotification(sub.subscription as any, JSON.stringify({
            title: "持ち物チェック",
            body: `${task.text}、持った？`,
            taskId: task.id,
            notificationId: `${task.id}-${nowMs}`,
            date: task.task_date,
          }));
          delivered = true;
          sentPushes++;
        } catch (err: any) {
          console.error("push error", err?.statusCode || "", err?.message || err);
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await admin.from("mochi_subscriptions").delete().eq("id", sub.id);
          }
        }
      }

      if (delivered) {
        const { error: updateError } = await admin
          .from("mochi_tasks")
          .update({ notified_at: new Date().toISOString() })
          .eq("id", task.id)
          .eq("done", false);
        if (updateError) throw updateError;
        deliveredTasks++;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      checkedAt: now,
      due: (tasks || []).length,
      deliveredTasks,
      sentPushes,
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "reminder worker failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
