package com.tzh.g4;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.InputStream;

/* ==========================================================================
   宿主 Activity：WebView 壳
   --------------------------------------------------------------------------
   页面从自定义源 https://g4.local/index.html 加载（安全上下文，localStorage 与
   剪贴板 API 可用），内容由 shouldInterceptRequest 从 assets 或外部覆盖文件
   组装后返回，因此页面对外始终表现为「同源」，/api/* 相对路径得以保留。
   ========================================================================== */
public class MainActivity extends Activity {

    public static final String PAGE_ORIGIN = "https://g4.local";
    public static final String PAGE_URL = PAGE_ORIGIN + "/index.html";

    private static MainActivity inst;
    private WebView web;
    private G4Bridge bridge;
    private G4Server.Listener listener;
    private boolean paused = true;
    private boolean pageLoaded = false;
    private long lastBack;

    public static MainActivity get() { return inst; }

    public boolean isBackground() { return paused; }

    /* ---------------- 生命周期 ---------------- */
    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        inst = this;
        edgeToEdge();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#eceef2"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setBuiltInZoomControls(false);
        ws.setSupportZoom(false);
        ws.setDisplayZoomControls(false);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        if (Build.VERSION.SDK_INT >= 21) ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        bridge = new G4Bridge(this);
        web.setWebViewClient(new Host());
        web.setWebChromeClient(new Chrome());
        web.addJavascriptInterface(bridge, "G4Native");
        /* 软键盘由注入层 visualViewport 避让，WebView 窗口不得被系统 pan/resize */
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);

        requestNotifyPermission();
        applySettings();
        web.loadUrl(PAGE_URL);
    }

    private void requestNotifyPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 2002);
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        inst = this;
        paused = false;
        applySettings();
        KeepAliveService.flush();
    }

    @Override
    protected void onPause() {
        paused = true;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            KeepAliveService.stop(this);
            stopServer();
            if (web != null) {
                web.stopLoading();
                web.destroy();
                web = null;
            }
        }
        if (inst == this) inst = null;
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) { web.goBack(); return; }
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) {
            super.onBackPressed();
        } else {
            lastBack = now;
            toast("再按一次退出对局");
        }
    }

    /* ---------------- 设置应用 ---------------- */
    public void applySettings() {
        if (Prefs.keepScreen(this)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        syncServer();
        /* 后台保活 = 用户总开关 && 页面汇报的"棋盘非空"。空棋盘不启动保活服务 */
        boolean need = Prefs.keepAlive(this) && bridge.isKeepAliveNeeded();
        if (need) KeepAliveService.start(this);
        else KeepAliveService.stop(this);
    }

    private void syncServer() {
        boolean want = Prefs.isLocal(this);
        int port = Prefs.port(this);
        if (want) {
            if (listener == null || !listener.isRunning() || listener.port() != port) {
                if (listener != null) listener.stop();
                listener = new G4Server.Listener(port, new G4Server.HtmlSource() {
                    @Override public byte[] html() {
                        String s = G4Assets.loadText(MainActivity.this, G4Assets.GAME_HTML);
                        return s.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                    }
                });
                if (listener.start()) {
                    toast("本机服务器已启动 " + Net.lanIp() + ":" + port);
                } else {
                    toast("端口 " + port + " 启动失败，请换一个端口");
                }
            }
        } else if (listener != null) {
            listener.stop();
            listener = null;
        }
    }

    private void stopServer() {
        if (listener != null) { listener.stop(); listener = null; }
    }

    public boolean serverRunning() { return listener != null && listener.isRunning(); }

    /* ---------------- 页面 ---------------- */
    public void reloadPage() {
        pageLoaded = false;
        if (web != null) web.loadUrl(PAGE_URL);
    }

    public void jsCallback(String id, int status, String body) {
        if (web == null) return;
        String js = "__g4HttpDone(" + JSONObject.quote(id) + "," + status + ","
                + JSONObject.quote(body == null ? "" : body) + ")";
        web.evaluateJavascript(js, null);
    }

    private class Host extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            String u = req.getUrl() == null ? "" : req.getUrl().toString();
            if (u.startsWith(PAGE_ORIGIN)) {
                String p = Uri.parse(u).getPath();
                if (p == null || p.equals("/") || p.equals("/index.html")) {
                    byte[] data = G4Assets.buildPage(MainActivity.this);
                    return new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(data));
                }
            }
            return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            String u = req.getUrl() == null ? "" : req.getUrl().toString();
            if (u.startsWith(PAGE_ORIGIN)) return false;
            openExternal(u);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageLoaded = true;
            pushInsets();
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            android.util.Log.d("G4Page", (m.sourceId() == null ? "" : m.sourceId())
                    + ":" + m.lineNumber() + " " + m.message());
            return true;
        }
    }

    /* ---------------- 安全区 ---------------- */
    private void edgeToEdge() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= 20) {
            decor.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    lastInsets = insets;
                    pushInsets();
                    return v.onApplyWindowInsets(insets);
                }
            });
        }
    }

    private WindowInsets lastInsets;

    private void pushInsets() {
        if (web == null || !pageLoaded || lastInsets == null) return;
        /* 系统返回的是原始像素（px）；WebView 的 CSS 像素 = px / 显示密度。
           之前按 px 直接写入 --g4-sat 等导致 inset 被放大约 density 倍（典型 ~3×），
           表现：菜单/悔棋/缩放提示「靠屏幕内侧」、竖屏上下不贴边 */
        float d = getResources().getDisplayMetrics().density;
        int t = Math.round(lastInsets.getSystemWindowInsetTop() / d);
        int r = Math.round(lastInsets.getSystemWindowInsetRight() / d);
        int bo = Math.round(lastInsets.getSystemWindowInsetBottom() / d);
        int l = Math.round(lastInsets.getSystemWindowInsetLeft() / d);
        web.evaluateJavascript("if(window.__g4Insets)__g4Insets(" + t + "," + r + "," + bo + "," + l + ")", null);
    }

    /* ---------------- 系统能力 ---------------- */
    public void copyToClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("g4", text));
            toast("已复制");
        } catch (Exception e) {
            toast("复制失败");
        }
    }

    public void toast(String msg) {
        if (msg == null) return;
        runOnUiThread(new Runnable() {
            final String m = msg;
            @Override public void run() {
                Toast.makeText(MainActivity.this, m, Toast.LENGTH_SHORT).show();
            }
        });
    }

    public void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast("无法打开链接");
        }
    }

    public void requestBatteryWhitelist() {
        if (Build.VERSION.SDK_INT >= 23) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                try {
                    Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    i.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(i);
                    return;
                } catch (Exception ignored) {}
            }
            toast("请在系统设置中允许后台运行并关闭电池优化");
        } else {
            toast("当前系统无需额外设置");
        }
    }

    /* ---------------- 导入页面 / 适配层 ---------------- */
    private static final int REQ_PICK = 1001;

    public void pickHtmlFile() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        try {
            startActivityForResult(Intent.createChooser(i, "选择 game.html 或 g4-mobile.js"), REQ_PICK);
        } catch (Exception e) {
            toast("无法打开文件选择器");
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK || res != RESULT_OK || data == null || data.getData() == null) return;
        String text = readUri(data.getData());
        if (text == null || text.isEmpty()) { toast("读取失败"); return; }
        boolean isShim = text.indexOf("__G4MOBILE__") >= 0;
        boolean isPage = text.indexOf("<canvas") >= 0 || text.indexOf("重力四子棋") >= 0;
        if (!isShim && !isPage) { toast("这既不是游戏页面也不是适配层"); return; }
        String name = isShim ? G4Assets.SHIM_JS : G4Assets.GAME_HTML;
        try {
            G4Assets.saveOverride(this, name, text);
            toast("已导入 " + name + "（" + G4Assets.shortHash(text) + "）");
            reloadPage();
        } catch (Exception e) {
            toast("保存失败: " + e.getMessage());
        }
    }

    private String readUri(Uri uri) {
        try {
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) return null;
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
            in.close();
            return new String(o.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
