unsigned long previousMillis;
unsigned int ansi = 1;
unsigned int clearCounter = 0;
const unsigned int CLEAR_COUNTER_MAX = 10;

void setup() { Serial.begin(9600); }

void loop() {
  if (Serial.available() > 0) {
    while (Serial.available() > 0) {
      Serial.write(Serial.read());
      delay(10);
    }
  } else if (millis() - previousMillis >= 500) {
    if (clearCounter == CLEAR_COUNTER_MAX) {
      Serial.print("\x1b[2J\x1b[3J\x1b[;H");
      clearCounter = 0;
    }
    previousMillis = millis();
    Serial.print("\x1b[3");
    Serial.print(ansi);
    Serial.print("mHallo\x1b[0m ");
    Serial.println(clearCounter);
    ansi++;
    clearCounter++;
    if (ansi > 6) {
      ansi = 1;
    }
    if (clearCounter == CLEAR_COUNTER_MAX) {
      Serial.println("Clearing terminal in next tick...");
    }
  }
}