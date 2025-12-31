unsigned long previousMillis;
unsigned int ansi = 1;
void setup() { Serial.begin(9600); }
void loop() {
  if (Serial.available() > 0) {
    while (Serial.available() > 0) {
      Serial.write(Serial.read());
      delay(10);
    }
  } else if (millis() - previousMillis >= 500) {
    previousMillis = millis();
    Serial.print("\x1b[3");
    Serial.print(ansi);
    Serial.println("mHello\x1b[0m");
    ansi++;
    if (ansi > 6) {
      ansi = 1;
    }
  }
}
