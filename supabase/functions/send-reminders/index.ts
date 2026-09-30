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

Deno.serve(async (req) => {
  const apiKey = req.headers.get("apikey") || "";
  if (!PUBLISHABLE_KEY || apiKey !== PUBLISHABLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return new Response("Push keys missing", { status: 503 });
  }

  const now = tokyoParts();
  try {
    const { data: tasks, error } = await admin
      .from("mochi_tasks")
      .select("id,user_id,text,task_date,task_time")
      .eq("done", false)
      .is("notified_at", null)
      .eq("task_date", now.date)
      .lte("task_time", `${now.time}:59`)
      .order("task_time");
    if (error) throw error;

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
          .is("notified_at", null);
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
