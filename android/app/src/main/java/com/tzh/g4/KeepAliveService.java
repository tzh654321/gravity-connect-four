package com.tzh.g4;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/* ==========================================================================
   保活服务：前台服务 + Wi-Fi 锁 + 后台轮询代理
   --------------------------------------------------------------------------
   为什么要接管轮询：Chromium 在页面不可见时会把定时器节流到约 1 分钟一次，
   而联机是 350ms 短轮询。退到后台后若听之任之，对手落子可能要等一分钟才同步。
   这里的做法是：页面发起的 /api/poll 在后台被挂起，改由本服务按 400ms 频率
   代跑，消息先累积；一旦有消息或回到前台，一次性回灌给页面。
   ========================================================================== */
public class KeepAliveService extends Service {

    private static final String CH_ALIVE = "g4_alive";
    private static final String CH_EVENT = "g4_event";
    private static final int NOTI_ALIVE = 1;
    private static final int NOTI_EVENT = 2;
    private static final long POLL_MS = 400;
    private static final long HOLD_MAX = 40000;

    private static KeepAliveService inst;

    private WifiManager.WifiLock wifiLock;
    private volatile boolean running;
    private volatile boolean forceFlush;
    private Thread worker;
    private long lastEventNotify;
    private String roomLabel = "";

    static final class Pending {
        final String id, method, url, body;
        long since;
        String opp = "none";
        boolean dead;
        final List<JSONObject> acc = new ArrayList<JSONObject>();
        final long start = System.currentTimeMillis();

        Pending(String id, String method, String url, String body) {
            this.id = id; this.method = method; this.url = url; this.body = body;
            this.since = parseSince(url);
        }
        static long parseSince(String url) {
            Map<String, String> q = G4Router.queryOf(url);
            try { return Long.parseLong(q.get("since")); } catch (Exception e) { return 0; }
        }
    }

    private static final List<Pending> PENDING = Collections.synchronizedList(new ArrayList<Pending>());

    /* ---------------- 对外接口 ---------------- */
    public static void start(Context c) {
        if (!Prefs.keepAlive(c)) return;
        try {
            Intent i = new Intent(c, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Exception e) {
            android.util.Log.w("G4Keep", "start: " + e.getMessage());
        }
    }

    public static void stop(Context c) {
        try { c.stopService(new Intent(c, KeepAliveService.class)); } catch (Exception ignored) {}
    }

    public static void hold(String id, String method, String url, String body) {
        Pending p = new Pending(id, method, url, body);
        PENDING.add(p);
        if (inst != null) {
            Map<String, String> q = G4Router.queryOf(url);
            String room = q.get("room");
            if (room != null && !room.isEmpty()) inst.setRoom(room);
        }
    }

    public static void flush() {
        if (inst != null) inst.forceFlush = true;
    }

    public static int pendingCount() { return PENDING.size(); }

    /* ---------------- 生命周期 ---------------- */
    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        createChannels();
        Notification n = buildAlive("联机保活中");
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTI_ALIVE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTI_ALIVE, n);
            }
        } catch (Exception e) {
            android.util.Log.e("G4Keep", "startForeground: " + e.getMessage());
        }
        acquireWifi();
        running = true;
        worker = new Thread(new Runnable() {
            @Override public void run() {
                while (running) {
                    try { Thread.sleep(POLL_MS); } catch (InterruptedException e) { break; }
                    tick();
                }
            }
        }, "g4-poll");
        worker.setDaemon(true);
        worker.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        releaseWifi();
        PENDING.clear();
        inst = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /* ---------------- 轮询代跑 ---------------- */
    private void tick() {
        Context ctx = getApplicationContext();
        synchronized (PENDING) {
            for (Pending p : PENDING) {
                String u = withSince(p.url, p.since);
                G4Server.Resp r = G4Router.route(ctx, "GET", u, null, 8000);
                if (r.status == 0) continue;
                try {
                    JSONObject j = new JSONObject(r.body);
                    if (j.optBoolean("dead")) { p.dead = true; continue; }
                    JSONArray ms = j.optJSONArray("msgs");
                    if (ms != null) {
                        for (int i = 0; i < ms.length(); i++) {
                            JSONObject m = ms.getJSONObject(i);
                            p.acc.add(m);
                            long id = m.optLong("id", 0);
                            if (id > p.since) p.since = id;
                            noteEvent(m);
                        }
                    }
                    if (j.has("opp")) p.opp = j.optString("opp", p.opp);
                } catch (Exception ignored) {}
            }
            boolean fg = !background();
            Iterator<Pending> it = PENDING.iterator();
            while (it.hasNext()) {
                Pending p = it.next();
                boolean due = p.dead || !p.acc.isEmpty() || fg || forceFlush
                        || (System.currentTimeMillis() - p.start > HOLD_MAX);
                if (due) {
                    it.remove();
                    deliver(p);
                }
            }
            forceFlush = false;
        }
    }

    private boolean background() {
        MainActivity a = MainActivity.get();
        return a == null || a.isBackground();
    }

    private void deliver(final Pending p) {
        final MainActivity a = MainActivity.get();
        if (a == null) return;
        JSONObject o = new JSONObject();
        try {
            if (p.dead) {
                o.put("dead", true);
            } else {
                JSONArray arr = new JSONArray();
                for (JSONObject m : p.acc) arr.put(m);
                o.put("msgs", arr);
                o.put("opp", p.opp);
            }
        } catch (Exception ignored) {}
        final String body = o.toString();
        final String id = p.id;
        a.runOnUiThread(new Runnable() {
            @Override public void run() { a.jsCallback(id, 200, body); }
        });
    }

    private static String withSince(String url, long since) {
        if (url == null) return "";
        if (url.contains("since=")) return url.replaceAll("since=\\d+", "since=" + since);
        return url + (url.contains("?") ? "&" : "?") + "since=" + since;
    }

    private void noteEvent(JSONObject m) {
        String t = m.optString("type", "");
        if (!"move".equals(t) && !"restart".equals(t) && !"undo".equals(t)) return;
        long now = System.currentTimeMillis();
        if (now - lastEventNotify < 5000) return;
        lastEventNotify = now;
        String title = "move".equals(t) ? "对手已落子" : ("restart".equals(t) ? "对方开了新局" : "对手悔棋");
        pushEvent(title, "点击回到对局");
    }

    /* ---------------- 通知 ---------------- */
    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel a = new NotificationChannel(CH_ALIVE, "联机保活", NotificationManager.IMPORTANCE_LOW);
        a.setDescription("保持联机连接与本地房间服务");
        nm.createNotificationChannel(a);
        NotificationChannel e = new NotificationChannel(CH_EVENT, "对局提醒", NotificationManager.IMPORTANCE_HIGH);
        e.setDescription("对手落子或重开时提醒");
        nm.createNotificationChannel(e);
    }

    private void setRoom(String room) {
        if (room.equals(roomLabel)) return;
        roomLabel = room;
        updateAlive();
    }

    private void updateAlive() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTI_ALIVE, buildAlive("联机保活中" + (roomLabel.isEmpty() ? "" : " · 房间 " + roomLabel)));
        }
    }

    private Notification buildAlive(String text) {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(this, CH_ALIVE);
        else b = new Notification.Builder(this);
        b.setContentTitle("重力四子棋")
         .setContentText(text)
         .setSmallIcon(R.drawable.ic_g4)
         .setOngoing(true)
         .setContentIntent(mainIntent())
         .setWhen(System.currentTimeMillis());
        return b.build();
    }

    private void pushEvent(String title, String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) b = new Notification.Builder(this, CH_EVENT);
        else b = new Notification.Builder(this);
        b.setContentTitle(title).setContentText(text)
         .setSmallIcon(R.drawable.ic_g4)
         .setAutoCancel(true)
         .setContentIntent(mainIntent());
        nm.notify(NOTI_EVENT, b.build());
    }

    private PendingIntent mainIntent() {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, 0, i, flags);
    }

    private void acquireWifi() {
        try {
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return;
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "g4:net");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
        } catch (Exception e) {
            android.util.Log.w("G4Keep", "wifilock: " + e.getMessage());
        }
    }

    private void releaseWifi() {
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {}
        wifiLock = null;
    }
}
