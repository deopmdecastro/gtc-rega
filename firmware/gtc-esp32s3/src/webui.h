#pragma once
/**
 * GTC Rega — Interface web local no ESP32-S3
 * ---------------------------------------------------------------
 * Serve a interface (build do frontend copiado para data/ → LittleFS) e uma
 * API JSON local com o estado REAL dos pinos, para que o painel funcione
 * mesmo sem o backend Node acessível.
 *
 *   http://<ip-do-esp32>/           → interface
 *   http://gtc-rega.local/          → interface (mDNS)
 *   GET  /api/local/status          → estado real (Wi-Fi, sensores, pinos)
 *   POST /api/local/emergency       → paragem de emergência local
 *
 * Requer (platformio.ini): ESPAsyncWebServer, AsyncTCP, ESPmDNS, LittleFS.
 */

#include <Arduino.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>

#include "config.h"

// Implementados em main.cpp — expõem o estado real do controlador.
String gtcStatusJson();
void gtcLocalEmergency();

static AsyncWebServer gtcServer(GTC_WEBUI_PORT);
static bool gtcFsReady = false;

inline void webuiBegin() {
  gtcFsReady = LittleFS.begin(true);
  if (!gtcFsReady) {
    Serial.println("[WEBUI] LittleFS indisponivel — apenas API local");
  }

  if (MDNS.begin(GTC_MDNS_HOST)) {
    MDNS.addService("http", "tcp", GTC_WEBUI_PORT);
    Serial.printf("[WEBUI] http://%s.local:%u\n", GTC_MDNS_HOST, GTC_WEBUI_PORT);
  }

  gtcServer.on("/api/local/status", HTTP_GET, [](AsyncWebServerRequest* req) {
    AsyncWebServerResponse* res = req->beginResponse(200, "application/json", gtcStatusJson());
    res->addHeader("Access-Control-Allow-Origin", "*");
    res->addHeader("Cache-Control", "no-store");
    req->send(res);
  });

  gtcServer.on("/api/local/emergency", HTTP_POST, [](AsyncWebServerRequest* req) {
    gtcLocalEmergency();
    AsyncWebServerResponse* res = req->beginResponse(200, "application/json", "{\"ok\":true}");
    res->addHeader("Access-Control-Allow-Origin", "*");
    req->send(res);
  });

  if (gtcFsReady) {
    gtcServer.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
  }

  // SPA fallback: qualquer rota desconhecida devolve a interface
  gtcServer.onNotFound([](AsyncWebServerRequest* req) {
    if (gtcFsReady && LittleFS.exists("/index.html")) {
      req->send(LittleFS, "/index.html", "text/html");
    } else {
      req->send(404, "text/plain", "GTC Rega — interface nao instalada (pio run -t uploadfs)");
    }
  });

  gtcServer.begin();
  Serial.printf("[WEBUI] servidor ativo em http://%s:%u\n",
                WiFi.localIP().toString().c_str(), GTC_WEBUI_PORT);
}
