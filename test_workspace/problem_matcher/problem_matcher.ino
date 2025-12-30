#include <Arduino.h>
__attribute__((deprecated("use newer()"))) int legacy(int p) {
  return analogRead(p);
}

void setup() {
  Serial.begin(9600);
  int v = legacy(A0); // warning + note: declared here (AVR-GCC)
  int unused = 1;     // warning: unused variable
  Serial.println(v);
}

void loop() {
  Serial.println(notDeclared); // error: not declared in this scope
}
