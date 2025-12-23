unsigned long previousMillis;
unsigned long counter = 0;

void setup() { Serial.begin(9600); }

void loop() {
  while (Serial.available() > 0) {
    Serial.write(Serial.read());
  }
  if (millis() - previousMillis >= 500) {
    previousMillis = millis();
    Serial.println(counter++);
  }
  delay(10);
}