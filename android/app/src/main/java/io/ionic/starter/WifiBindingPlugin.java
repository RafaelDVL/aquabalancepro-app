package io.ionic.starter;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

@CapacitorPlugin(name = "WifiBinding")
public class WifiBindingPlugin extends Plugin {
  @PluginMethod
  public void bindToWifi(PluginCall call) {
    String targetSsid = call.getString("ssid", null);
    ConnectivityManager cm =
        (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);

    if (cm == null) {
      call.reject("ConnectivityManager indisponivel");
      return;
    }

    Network wifiNetwork = null;
    for (Network network : cm.getAllNetworks()) {
      NetworkCapabilities caps = cm.getNetworkCapabilities(network);
      if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
        wifiNetwork = network;
        break;
      }
    }

    if (wifiNetwork == null) {
      call.reject("Nenhuma rede Wi-Fi encontrada");
      return;
    }

    String currentSsid = getCurrentSsid();
    if (targetSsid != null && currentSsid != null && !targetSsid.equals(currentSsid)) {
      call.reject("SSID atual diferente do esperado: " + currentSsid);
      return;
    }

    boolean ok = cm.bindProcessToNetwork(wifiNetwork);
    if (!ok) {
      call.reject("Falha ao fixar processo na rede Wi-Fi");
      return;
    }

    JSObject ret = new JSObject();
    ret.put("ok", true);
    if (currentSsid != null) {
      ret.put("ssid", currentSsid);
    }
    call.resolve(ret);
  }

  @PluginMethod
  public void clearBinding(PluginCall call) {
    ConnectivityManager cm =
        (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);

    if (cm == null) {
      call.reject("ConnectivityManager indisponivel");
      return;
    }

    boolean ok = cm.bindProcessToNetwork(null);
    JSObject ret = new JSObject();
    ret.put("ok", ok);
    call.resolve(ret);
  }

  private String getCurrentSsid() {
    try {
      WifiManager wm = (WifiManager) getContext().getApplicationContext()
          .getSystemService(Context.WIFI_SERVICE);
      if (wm == null) {
        return null;
      }
      WifiInfo info = wm.getConnectionInfo();
      if (info == null) {
        return null;
      }
      String ssid = info.getSSID();
      if (ssid == null) {
        return null;
      }
      if (ssid.startsWith("\"") && ssid.endsWith("\"")) {
        ssid = ssid.substring(1, ssid.length() - 1);
      }
      if ("<unknown ssid>".equalsIgnoreCase(ssid)) {
        return null;
      }
      return ssid;
    } catch (Exception ignored) {
      return null;
    }
  }
}
