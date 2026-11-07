/*
========================================================
 INKLINK — ESP32-S3 LIVE DEVICE FIRMWARE
 Version: 1.0.0

 Backend URL, Wi-Fi, device and shop ids: config.h
 Device token: secrets.h (never committed)

 Features:
 - WiFi connection
 - SNTP clock synchronization
 - HTTPS with GTS Root R1
 - Backend health check
 - Authenticated device heartbeat
 - Live job and payment polling
 - Hedera verification display
 - OLED navigation
 - LED status indicators

 IMPORTANT:
 - Does not simulate payments.
 - Does not generate transaction IDs.
 - Does not authorize printing.
 - Does not report fake printer events.
========================================================
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <time.h>

#include "config.h"   // Wi-Fi, backend URL, device and shop ids (safe to commit)
#include "secrets.h"  // DEVICE_TOKEN (git-ignored; copy secrets.example.h)
#include "gts_root_r1.h"

// ======================================================
// DEVICE CONFIGURATION (values live in config.h)
// ======================================================

const char* WIFI_SSID = CFG_WIFI_SSID;
const char* WIFI_PASSWORD = CFG_WIFI_PASSWORD;
const char* BACKEND = CFG_BACKEND_URL;
const char* DEVICE_ID = CFG_DEVICE_ID;
const char* SHOP_ID = CFG_SHOP_ID;

const char* FIRMWARE_VERSION = "1.0.0";

// ======================================================
// GPIO CONFIGURATION — EXISTING CIRCUIT
// ======================================================

#define BTN_CONFIRM 4
#define BTN_CANCEL  5
#define BTN_NEXT    6
#define BTN_PREV    7

#define OLED_SDA 8
#define OLED_SCL 9

#define LED_READY   10
#define LED_PROCESS 11
#define LED_ERROR   12

#define BUZZER 13

// ======================================================
// OLED CONFIGURATION
// ======================================================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_ADDRESS 0x3C
#define OLED_RESET -1

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  OLED_RESET
);

// ======================================================
// ENDPOINTS
// ======================================================

const char* HEALTH_ENDPOINT = "/health";

const char* HEARTBEAT_ENDPOINT =
  "/api/v1/devices/heartbeat";

const char* DISPLAY_ENDPOINT =
  "/api/v1/devices/display";

// ======================================================
// TIMERS
// ======================================================

const unsigned long HEARTBEAT_INTERVAL = 20000;
const unsigned long DISPLAY_INTERVAL = 3000;

unsigned long lastHeartbeat = 0;
unsigned long lastDisplayPoll = 0;
unsigned long lastReconnectAttempt = 0;

const unsigned long RECONNECT_INTERVAL = 10000;

// ======================================================
// CONNECTION STATE
// ======================================================

bool wifiConnected = false;
bool clockReady = false;
bool backendOnline = false;
bool tokenRejected = false;

String connectionStatus = "STARTING";

// ======================================================
// LIVE BACKEND DATA
// ======================================================

String jobId = "";
String jobState = "IDLE";

String paymentStatus = "NOT STARTED";
String verificationStatus = "not_started";

String paymentId = "";
String amount = "--";
String asset = "--";
String networkName = "--";

String transactionId = "";
String hashscanUrl = "";

String executionAuthorized = "NO";
String deviceStatus = "UNKNOWN";

String shopName = "Inklink Shop";
bool acceptingOrders = false;
bool gatewayConnected = false;

bool hasActiveJob = false;

// ======================================================
// OLED NAVIGATION
// ======================================================

int currentPage = 0;

const int TOTAL_PAGES = 6;

bool lastNext = HIGH;
bool lastPrev = HIGH;
bool lastConfirm = HIGH;

// ======================================================
// HELPERS
// ======================================================

String shorten(String value, int maxLength) {
  if (value.length() <= maxLength) {
    return value;
  }

  return value.substring(0, maxLength - 3) + "...";
}

void beep(int duration = 80) {
  digitalWrite(BUZZER, HIGH);
  delay(duration);
  digitalWrite(BUZZER, LOW);
}

void clearJobData() {
  jobId = "";
  jobState = "IDLE";

  paymentStatus = "NOT STARTED";
  verificationStatus = "not_started";

  paymentId = "";
  amount = "--";
  asset = "--";
  networkName = "--";

  transactionId = "";
  hashscanUrl = "";

  executionAuthorized = "NO";

  hasActiveJob = false;
}

// ======================================================
// DISPLAY HELPERS
// ======================================================

void showMessage(
  const String& title,
  const String& message
) {
  display.clearDisplay();

  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 0);
  display.println("INKLINK");

  display.drawLine(0, 12, 127, 12, SSD1306_WHITE);

  display.setCursor(0, 23);
  display.println(title);

  display.setCursor(0, 42);
  display.println(message);

  display.display();
}

void renderPage() {

  display.clearDisplay();

  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);

  display.setCursor(0, 0);

  display.print("INKLINK ");

  if (backendOnline) {
    display.print("ONLINE");
  } else {
    display.print("OFFLINE");
  }

  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  switch (currentPage) {

    // ================================================
    // PAGE 1 — DEVICE STATUS
    // ================================================

    case 0:

      display.setCursor(0, 17);
      display.println("DEVICE STATUS");

      display.setCursor(0, 30);
      display.println(connectionStatus);

      display.setCursor(0, 43);
      display.print("ID: ");
      display.println(DEVICE_ID);

      display.setCursor(0, 55);
      display.print("Shop: ");
      display.println(SHOP_ID);

      break;

    // ================================================
    // PAGE 2 — ACTIVE JOB
    // ================================================

    case 1:

      display.setCursor(0, 17);
      display.println("ACTIVE JOB");

      display.setCursor(0, 30);
      display.print("ID: ");

      display.println(
        hasActiveJob ? shorten(jobId, 17) : "None"
      );

      display.setCursor(0, 43);
      display.print("State: ");
      display.println(jobState);

      display.setCursor(0, 55);
      display.print("Print auth: ");
      display.println(executionAuthorized);

      break;

    // ================================================
    // PAGE 3 — PAYMENT
    // ================================================

    case 2:

      display.setCursor(0, 17);
      display.println("PAYMENT DETAILS");

      display.setCursor(0, 30);
      display.print("Status: ");
      display.println(shorten(paymentStatus, 16));

      display.setCursor(0, 43);
      display.print("Amount: ");
      display.print(amount);
      display.print(" ");
      display.println(asset);

      display.setCursor(0, 55);
      display.print("Network: ");
      display.println(networkName);

      break;

    // ================================================
    // PAGE 4 — HEDERA VERIFICATION
    // ================================================

    case 3:

      display.setCursor(0, 16);
      display.println("HEDERA PAYMENT");

      display.setCursor(0, 28);
      display.print("Verification:");

      display.setCursor(0, 39);
      display.println(verificationStatus);

      display.setCursor(0, 51);

      if (transactionId.length() > 0) {
        display.println(shorten(transactionId, 21));
      } else {
        display.println("No transaction yet");
      }

      break;

    // ================================================
    // PAGE 5 — PRINTER STATUS
    // ================================================

    case 4:

      display.setCursor(0, 17);
      display.println("PRINTER STATUS");

      display.setCursor(0, 30);
      display.print("Device: ");
      display.println(deviceStatus);

      display.setCursor(0, 43);
      display.print("Gateway: ");
      display.println(
        gatewayConnected ? "CONNECTED" : "OFFLINE"
      );

      display.setCursor(0, 55);
      display.print("Orders: ");
      display.println(
        acceptingOrders ? "ACCEPTING" : "PAUSED"
      );

      break;

    // ================================================
    // PAGE 6 — SHOP DETAILS
    // ================================================

    case 5:

      display.setCursor(0, 17);
      display.println("SHOP INFORMATION");

      display.setCursor(0, 31);
      display.println(shorten(shopName, 21));

      display.setCursor(0, 45);
      display.print("Device: ");
      display.println(DEVICE_ID);

      break;
  }

  display.drawLine(0, 62, 127, 62, SSD1306_WHITE);

  display.display();
}

// ======================================================
// TLS CONFIGURATION
// ======================================================

bool initializeTLS(WiFiClientSecure& client) {

  if (!clockReady) {
    return false;
  }

  client.setCACert(GTS_ROOT_R1);

  client.setTimeout(10000);

  return true;
}

// ======================================================
// CLOCK SYNCHRONIZATION
// ======================================================

bool synchronizeClock() {

  configTime(
    0,
    0,
    "pool.ntp.org",
    "time.google.com"
  );

  struct tm timeInfo;

  for (int i = 0; i < 20; i++) {

    if (getLocalTime(&timeInfo, 1000)) {

      clockReady = true;

      Serial.println("Clock synchronized");

      return true;
    }

    delay(300);
  }

  clockReady = false;

  Serial.println("Clock synchronization failed");

  return false;
}

// ======================================================
// HEALTH CHECK
// ======================================================

int checkBackendHealth() {

  WiFiClientSecure client;

  if (!initializeTLS(client)) {
    return -1;
  }

  HTTPClient http;

  String url = String(BACKEND) + HEALTH_ENDPOINT;

  if (!http.begin(client, url)) {
    return -1;
  }

  http.setTimeout(10000);

  int status = http.GET();

  http.end();

  Serial.printf("Health HTTP: %d\n", status);

  return status;
}

// ======================================================
// HEARTBEAT — EXACT BACKEND SCHEMA
// ======================================================

bool sendHeartbeat() {

  WiFiClientSecure client;

  if (!initializeTLS(client)) {
    return false;
  }

  HTTPClient http;

  String url = String(BACKEND) + HEARTBEAT_ENDPOINT;

  if (!http.begin(client, url)) {
    return false;
  }

  http.addHeader(
    "Authorization",
    String("Bearer ") + DEVICE_TOKEN
  );

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  StaticJsonDocument<512> doc;

  doc["deviceId"] = DEVICE_ID;
  doc["shopId"] = SHOP_ID;
  doc["type"] = "esp32-s3";
  doc["firmware"] = FIRMWARE_VERSION;
  doc["state"] = jobState;
  doc["printerId"] = nullptr;
  doc["detail"] = nullptr;

  String payload;

  serializeJson(doc, payload);

  Serial.println("Sending heartbeat...");

  int status = http.POST(payload);

  String response = http.getString();

  Serial.printf("Heartbeat HTTP: %d\n", status);

  Serial.println(response);

  http.end();

  if (status == 401) {

    tokenRejected = true;
    backendOnline = false;
    connectionStatus = "TOKEN REJECTED";

    return false;
  }

  if (status == 200) {

    tokenRejected = false;
    backendOnline = true;

    connectionStatus = "DEVICE ONLINE";

    return true;
  }

  backendOnline = false;

  return false;
}

// ======================================================
// LIVE DISPLAY ENDPOINT
// ======================================================

bool fetchDisplayData() {

  WiFiClientSecure client;

  if (!initializeTLS(client)) {
    return false;
  }

  HTTPClient http;

  String url =
    String(BACKEND) +
    DISPLAY_ENDPOINT +
    "?deviceId=" +
    DEVICE_ID;

  if (!http.begin(client, url)) {
    return false;
  }

  http.addHeader(
    "Authorization",
    String("Bearer ") + DEVICE_TOKEN
  );

  http.addHeader(
    "Accept",
    "application/json"
  );

  http.setTimeout(10000);

  int status = http.GET();

  String response = http.getString();

  http.end();
  Serial.println("========== BACKEND RESPONSE ==========");
  Serial.println(response);
  Serial.println("======================================");

  Serial.printf("Display HTTP: %d\n", status);

  if (status != 200) {

    if (status == 401) {

      tokenRejected = true;
      backendOnline = false;
      connectionStatus = "TOKEN REJECTED";

    } else if (status == 404) {

      connectionStatus = "DEVICE NOT REGISTERED";

    } else if (status == 503) {

      connectionStatus = "TOKEN NOT CONFIGURED";

    } else {

      connectionStatus = "DISPLAY UNAVAILABLE";
    }

    return false;
  }

  StaticJsonDocument<12288> doc;

  DeserializationError error =
    deserializeJson(doc, response);

  if (error) {

    Serial.print("JSON error: ");
    Serial.println(error.c_str());

    connectionStatus = "INVALID SERVER DATA";

    return false;
  }

  // DEVICE DATA

  JsonObject device = doc["device"];

  deviceStatus =
    device["status"] | "unknown";

  // SHOP DATA

  JsonObject shop = doc["shop"];

  shopName =
    shop["name"] | "Inklink Shop";

  acceptingOrders =
    shop["accepting_orders"] | false;

  // PRINTER DATA

  JsonObject printer = doc["printer"];

  gatewayConnected =
    printer["gateway_connected"] | false;

  // ACTIVE JOB

  JsonVariant activeJob = doc["active_job"];

  if (activeJob.isNull()) {

    clearJobData();

  } else {

    JsonObject job = activeJob.as<JsonObject>();

    hasActiveJob = true;

    jobId =
      job["job_id"] | "";

    jobState =
      job["job_state"] | "UNKNOWN";

    paymentStatus =
      job["payment_status"] | "unknown";

    paymentId =
      job["payment_id"] | "";

    amount =
      job["amount"].isNull()
      ? "--"
      : job["amount"].as<String>();

    asset =
      job["asset"] | "--";

    networkName =
      job["network"] | "--";

    transactionId =
      job["transaction_id"] | "";

    verificationStatus =
      job["verification_status"] | "not_started";

    hashscanUrl =
      job["hashscan_url"] | "";

    bool authorized =
      job["execution_authorized"] | false;

    executionAuthorized =
      authorized ? "YES" : "NO";

    deviceStatus =
      job["device_status"] | deviceStatus;
  }

  backendOnline = true;

  connectionStatus = "DEVICE ONLINE";

  // LED INDICATORS

  digitalWrite(LED_ERROR, LOW);

  if (executionAuthorized == "YES") {

    digitalWrite(LED_READY, HIGH);
    digitalWrite(LED_PROCESS, LOW);

  } else if (jobState == "executing" ||
             jobState == "processing") {

    digitalWrite(LED_READY, LOW);
    digitalWrite(LED_PROCESS, HIGH);

  } else {

    digitalWrite(LED_READY, LOW);
    digitalWrite(LED_PROCESS, LOW);
  }

  renderPage();

  return true;
}

// ======================================================
// WIFI CONNECTION
// ======================================================

bool connectWiFi() {

  WiFi.mode(WIFI_STA);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  showMessage(
    "CONNECTING",
    "Joining Wi-Fi"
  );

  Serial.println("Connecting to WiFi...");

  int attempts = 0;

  while (
    WiFi.status() != WL_CONNECTED &&
    attempts < 30
  ) {

    delay(500);
    attempts++;
  }

  wifiConnected =
    WiFi.status() == WL_CONNECTED;

  if (!wifiConnected) {

    connectionStatus = "NO WIFI";

    Serial.println("WiFi connection failed");

    return false;
  }

  Serial.println("WiFi connected");

  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  showMessage(
    "WIFI CONNECTED",
    "Synchronizing clock"
  );

  if (!synchronizeClock()) {

    connectionStatus = "CLOCK SYNC FAILED";

    return false;
  }

  showMessage(
    "CHECKING BACKEND",
    "Secure HTTPS request"
  );

  int health = checkBackendHealth();

  if (health != 200) {

    connectionStatus = "BACKEND UNREACHABLE";

    backendOnline = false;

    return false;
  }

  Serial.println("Backend health check passed");

  return true;
}

// ======================================================
// BUTTON NAVIGATION
// ======================================================

void handleButtons() {

  bool next = digitalRead(BTN_NEXT);
  bool prev = digitalRead(BTN_PREV);
  bool confirm = digitalRead(BTN_CONFIRM);

  if (lastNext == HIGH && next == LOW) {

    currentPage++;

    if (currentPage >= TOTAL_PAGES) {
      currentPage = 0;
    }

    beep();

    renderPage();
  }

  if (lastPrev == HIGH && prev == LOW) {

    currentPage--;

    if (currentPage < 0) {
      currentPage = TOTAL_PAGES - 1;
    }

    beep();

    renderPage();
  }

  if (lastConfirm == HIGH && confirm == LOW) {

    showMessage(
      "INKLINK",
      "Use shop dashboard"
    );

    beep();

    delay(700);

    renderPage();
  }

  lastNext = next;
  lastPrev = prev;
  lastConfirm = confirm;
}

// ======================================================
// SETUP
// ======================================================

void setup() {

  Serial.begin(115200);

  // BUTTONS

  pinMode(BTN_CONFIRM, INPUT_PULLUP);
  pinMode(BTN_CANCEL, INPUT_PULLUP);
  pinMode(BTN_NEXT, INPUT_PULLUP);
  pinMode(BTN_PREV, INPUT_PULLUP);

  // OUTPUTS

  pinMode(LED_READY, OUTPUT);
  pinMode(LED_PROCESS, OUTPUT);
  pinMode(LED_ERROR, OUTPUT);

  pinMode(BUZZER, OUTPUT);

  digitalWrite(LED_READY, LOW);
  digitalWrite(LED_PROCESS, LOW);
  digitalWrite(LED_ERROR, LOW);
  digitalWrite(BUZZER, LOW);

  // OLED

  Wire.begin(
    OLED_SDA,
    OLED_SCL
  );

  if (!display.begin(
    SSD1306_SWITCHCAPVCC,
    OLED_ADDRESS
  )) {

    Serial.println("OLED initialization failed");

    while (true) {
      delay(1000);
    }
  }

  showMessage(
    "INKLINK",
    "Initializing device"
  );

  delay(1000);

  // NETWORK

  bool connected = connectWiFi();

  if (!connected) {

    digitalWrite(LED_ERROR, HIGH);

    showMessage(
      "CONNECTION ERROR",
      connectionStatus
    );

  } else {

    // First heartbeat registers device.

    bool heartbeatOK = sendHeartbeat();

    if (heartbeatOK) {

      lastHeartbeat = millis();

      // Fetch live backend records.

      if (!fetchDisplayData()) {

        Serial.println(
          "Device registered; display data unavailable"
        );
      }

    } else {

      digitalWrite(LED_ERROR, HIGH);

      showMessage(
        "HEARTBEAT FAILED",
        connectionStatus
      );
    }
  }

  renderPage();
}

// ======================================================
// MAIN LOOP
// ======================================================

void loop() {

  handleButtons();

  // WIFI LOST

  if (WiFi.status() != WL_CONNECTED) {

    wifiConnected = false;
    backendOnline = false;

    connectionStatus = "NO WIFI";

    digitalWrite(LED_READY, LOW);
    digitalWrite(LED_PROCESS, LOW);
    digitalWrite(LED_ERROR, HIGH);

    if (
      millis() - lastReconnectAttempt >=
      RECONNECT_INTERVAL
    ) {

      lastReconnectAttempt = millis();

      connectWiFi();
    }

    delay(20);

    return;
  }

  wifiConnected = true;

  // HEARTBEAT EVERY 20 SECONDS

  if (
    millis() - lastHeartbeat >=
    HEARTBEAT_INTERVAL
  ) {

    if (sendHeartbeat()) {

      Serial.println("Heartbeat successful");

    } else {

      Serial.println("Heartbeat failed");

      digitalWrite(LED_ERROR, HIGH);
    }

    lastHeartbeat = millis();
  }

  // FETCH BACKEND DATA EVERY 3 SECONDS

  if (
    millis() - lastDisplayPoll >=
    DISPLAY_INTERVAL
  ) {

    if (!tokenRejected) {

      fetchDisplayData();
    }

    lastDisplayPoll = millis();
  }

  delay(20);
}

