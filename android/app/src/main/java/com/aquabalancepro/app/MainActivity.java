package com.aquabalancepro.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Plugins locais precisam ser registrados antes do super.onCreate, que cria a ponte com o WebView
    registerPlugin(WifiBindingPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
