#pragma once
/**
 * GTC Rega — Interface web local no ESP32-S3
 * ---------------------------------------------------------------
 * Serve a interface (build do frontend copiado para data/ → LittleFS) e uma
 * API JSON local com o estado REAL dos pinos, para que o painel funcione
 * mesmo sem o backend Node acessível.
 *
 *   http://<ip-do-esp32>/                → interface
 *   http://gtc-rega.local/               → interface (mDNS)
 *   GET  /api/local/status               → estado completo (Wi-Fi, sensores, pinos, setpoints)
 *   POST /api/local/command              → {action:start|stop|reset|auto_on} ou {setpoint:{...}}
 *   POST /api/local/emergency            → paragem de emergência local (legacy)
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
void sendTelemetryNow();
void applyLocalCommand(const String& body);

static AsyncWebServer gtcServer(GTC_WEBUI_PORT);
static bool gtcFsReady = false;

inline void webuiBegin() {
  gtcFsReady = LittleFS.begin(true);
  if (!gtcFsReady) {
    Serial.println("[WEBUI] LittleFS indisponivel \u2014 apenas API local");
  }

  if (MDNS.begin(GTC_MDNS_HOST)) {
    MDNS.addService("http", "tcp", GTC_WEBUI_PORT);
    Serial.printf("[WEBUI] http://%s.local:%u\n", GTC_MDNS_HOST, GTC_WEBUI_PORT);
  }

  // Default headers CORS — facilita testes via curl/Postman
  gtcServer.begin();

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

  // Endpoint de controlo local — aceita JSON {"action":"start|stop|reset|auto_on|auto_off"}
  // ou ler/escrever setpoints {"setpoint":{...}}.
  gtcServer.on(
      "/api/local/command", HTTP_POST,
      [](AsyncWebServerRequest* req) {}, NULL,
      [](AsyncWebServerRequest* req, uint8_t* data, size_t len, size_t index, size_t total) {
        static String body;
        if (index == 0) body = "";
        body += String((const char*)data).substring(0, len);
        if (index + len == total) {
          applyLocalCommand(body);
          AsyncWebServerResponse* res = req->beginResponse(200, "application/json", "{\"ok\":true}");
          res->addHeader("Access-Control-Allow-Origin", "*");
          req->send(res);
        }
      });

  gtcServer.on("/api/local/command", HTTP_OPTIONS, [](AsyncWebServerRequest* req) {
    AsyncWebServerResponse* res = req->beginResponse(200, "text/plain", "ok");
    res->addHeader("Access-Control-Allow-Origin", "*");
    res->addHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res->addHeader("Access-Control-Allow-Headers", "Content-Type");
    req->send(res);
  });

  if (gtcFsReady) {
    gtcServer.serveStatic("/", LittleFS, "/").setDefaultFile("index.html");
  }

  gtcServer.onNotFound([](AsyncWebServerRequest* req) {
    if (gtcFsReady && LittleFS.exists("/index.html")) {
      req->send(LittleFS, "/index.html", "text/html");
    } else {
      req->send(404, "text/plain", "GTC Rega \u2014 interface nao instalada (pio run -t uploadfs)");
    }
  });

  Serial.printf("[WEBUI] servidor ativo em http://%s:%u\n",
                WiFi.localIP().toString().c_str(), GTC_WEBUI_PORT);
}
