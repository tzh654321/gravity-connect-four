package com.tzh.g4;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/* ==========================================================================
   JS 桥：页面（注入层）与原生之间的唯一通道
   --------------------------------------------------------------------------
   所有方法都在 JavaBridge 线程被调用，耗时操作必须另开线程，
   回调 WebView 必须切回 UI 线程。
   ========================================================================== */
public class G4Bridge {

    private final MainActivity act;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);

    G4Bridge(MainActivity a) { act = a; }

    /* ---------------- 网络 ---------------- */
    @JavascriptInterface
    public void http(final String id, final String method, final String url, final String body) {
        if ("/api/poll".equals(G4Router.pathOf(url)) && (act == null || act.isBackground())) {
            KeepAliveService.hold(id, method, url, body);   // 后台由服务代跑，避免定时器被节流
            return;
        }
        pool.execute(new Runnable() {
            @Override public void run() {
                G4Server.Resp r = G4Router.route(act, method, url, body);
                deliver(id, r.status, r.body);
            }
        });
    }

    private void deliver(final String id, final int status, final String body) {
        if (act == null) return;
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.jsCallback(id, status, body); }
        });
    }

    /* ---------------- 系统能力 ---------------- */
    @JavascriptInterface
    public void copy(final String text) {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.copyToClipboard(text); }
        });
    }

    /* ---------------- 后台保活粒度控制 ---------------- */
    /* 页面在棋盘空/有子时通知 native；native 在 applySettings 时把 keepAlive 开关和
       keepAliveNeeded 共同决定 KeepAliveService 的启动/停止，避免「本地对局空棋盘」也常驻通知 */
    private volatile boolean keepAliveNeeded = false;
    @JavascriptInterface
    public void setKeepAliveNeeded(final boolean needed) {
        if (this.keepAliveNeeded == needed) return;
        this.keepAliveNeeded = needed;
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.applySettings(); }
        });
    }
    public boolean isKeepAliveNeeded() { return keepAliveNeeded; }

    @JavascriptInterface
    public void toast(final String msg) {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.toast(msg); }
        });
    }

    @JavascriptInterface
    public void log(String msg) {
        android.util.Log.d("G4JS", msg);
    }

    /* ---------------- 配置 ---------------- */
    @JavascriptInterface
    public String getConfig() {
        try {
            JSONObject o = new JSONObject();
            o.put("local", Prefs.isLocal(act));
            o.put("base", Prefs.remoteBase(act));
            o.put("port", Prefs.port(act));
            o.put("tap", Prefs.tapToPlace(act));
            o.put("screen", Prefs.keepScreen(act));
            o.put("alive", Prefs.keepAlive(act));
            o.put("htmlSrc", G4Assets.sourceLabel(act, G4Assets.GAME_HTML));
            o.put("shimSrc", G4Assets.sourceLabel(act, G4Assets.SHIM_JS));
            o.put("ip", Net.lanIp());
            o.put("listening", act.serverRunning());
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    @JavascriptInterface
    public void setConfig(String json) {
        try {
            JSONObject o = new JSONObject(json);
            if (o.has("local")) Prefs.setLocal(act, o.optBoolean("local"));
            if (o.has("base")) Prefs.setRemoteBase(act, o.optString("base", ""));
            if (o.has("port")) Prefs.setPort(act, o.optInt("port", 8765));
            if (o.has("tap")) Prefs.setTapToPlace(act, o.optBoolean("tap"));
            if (o.has("screen")) Prefs.setKeepScreen(act, o.optBoolean("screen"));
            if (o.has("alive")) Prefs.setKeepAlive(act, o.optBoolean("alive"));
        } catch (Exception ignored) {}
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.applySettings(); }
        });
    }

    @JavascriptInterface
    public void reload() {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.reloadPage(); }
        });
    }

    @JavascriptInterface
    public void importHtml() {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.pickHtmlFile(); }
        });
    }

    @JavascriptInterface
    public void clearOverrides() {
        G4Assets.clearOverride(act, G4Assets.GAME_HTML);
        G4Assets.clearOverride(act, G4Assets.SHIM_JS);
        act.runOnUiThread(new Runnable() {
            @Override public void run() {
                act.toast("已恢复内置版本");
                act.reloadPage();
            }
        });
    }

    @JavascriptInterface
    public void batteryOpt() {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.requestBatteryWhitelist(); }
        });
    }

    @JavascriptInterface
    public void openUrl(final String url) {
        act.runOnUiThread(new Runnable() {
            @Override public void run() { act.openExternal(url); }
        });
    }
}
