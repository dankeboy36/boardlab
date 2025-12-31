// Based on https://github.com/nathandunk/BetterSerialPlotter
// Extra signal ideas adapted from:
//  - uPlot:
//  https://github.com/leeoniya/uPlot/blob/b64596308632d1a9f221b1f81f2398b671c1f053/demos/sine-stream.html
//  - Box–Muller transform (normal noise): http://jsfiddle.net/Xotic750/3rfT6/
//  - Gaussian helpers:
//  https://newbedev.com/javascript-math-random-normal-distribution-gaussian-bell-curve

// Simple clamp helper
static inline float clampf(float v, float lo, float hi) {
  if (v < lo)
    return lo;
  if (v > hi)
    return hi;
  return v;
}

// Uniform random in (0, 1). Avoid exact 0 to keep Box–Muller stable.
static float urand01() {
  long r = random(1, 32767); // (0, 32767)
  return (float)r / 32767.0f;
}

// Box–Muller normal(0,1). Caches the second sample.
static float gauss01() {
  static bool hasSpare = false;
  static float spare;
  if (hasSpare) {
    hasSpare = false;
    return spare;
  }
  float u, v, s;
  do {
    u = 2.0f * urand01() - 1.0f; // (-1,1)
    v = 2.0f * urand01() - 1.0f; // (-1,1)
    s = u * u + v * v;
  } while (s >= 1.0f || s == 0.0f);

  float mul = sqrtf(-2.0f * logf(s) / s);
  spare = v * mul;
  hasSpare = true;
  return u * mul;
}

// State for random walks
static float rw1 = 0.0f;
static float rw2 = 0.0f;

// Sample period limiter (about 50 Hz)
static unsigned long lastMs = 0;

void setup() {
  Serial.begin(9600);
  // best-effort seeding
  randomSeed(analogRead(A0));
}

void loop() {
  unsigned long now = millis();

  // time base in seconds (explicit X)
  float t = (float)now / 1000.0f;

  // Base waves
  float s1 = sinf(t);                              // sin(t)
  float c1 = cosf(t * 0.8f);                       // cos(0.8t)
  float tri = asinf(sinf(t * 0.5f)) * (2.0f / PI); // triangle in [-1,1]

  // Noisy sine (light gaussian noise)
  float noisy = s1 + 0.15f * gauss01();

  // Random walks (bounded)
  rw1 = clampf(rw1 + 0.05f * gauss01(), -1.0f, 1.0f);
  rw2 = clampf(rw2 + 0.02f * gauss01(), -1.0f, 1.0f);

  // Print BetterSerialPlotter format: t, y1, y2, ...
  Serial.print(t, 4);
  Serial.print('\t');
  Serial.print(s1, 4);
  Serial.print('\t');
  Serial.print(c1, 4);
  Serial.print('\t');
  Serial.print(tri, 4);
  Serial.print('\t');
  Serial.print(noisy, 4);
  Serial.print('\t');
  Serial.print(rw1, 4);
  Serial.print('\t');
  Serial.println(rw2, 4);
}
