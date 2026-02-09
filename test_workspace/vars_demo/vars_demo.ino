#include <Arduino.h>
#include <string.h>

struct Point {
  int x;
  int y;
};

struct Config {
  int id;
  float scale;
  char label[16];
  Point origin;
};

struct Pair {
  const char *key;
  int value;
};

struct SimpleMap {
  Pair entries[4];
  int count;
  __attribute__((noinline)) int get(const char *key) const {
    for (int i = 0; i < count; i++) {
      if (strcmp(entries[i].key, key) == 0) {
        return entries[i].value;
      }
    }
    return -1;
  }
};

class Accumulator {
public:
  __attribute__((noinline)) int sum(const int *data, int len) const {
    int total = 0;
    for (int i = 0; i < len; i++) {
      total += data[i];
    }
    return total;
  }
};

static volatile int g_counter = 0;
static int g_values[] = {3, 1, 4, 1, 5, 9, 2, 6};
static Pair g_pairs[] = {
    {"alpha", 11}, {"beta", 22}, {"gamma", 33}, {"delta", 44}};
static Config g_config = {42, 2.5f, "vars_demo", {7, 11}};
static SimpleMap g_map = {{{"one", 1}, {"two", 2}, {"three", 3}, {"four", 4}},
                          4};

__attribute__((noinline)) int level3(const SimpleMap &map, const Config &cfg,
                                     const int *data, int len) {
  int localBuf[3] = {data[0], data[1], data[2]};
  Point localPoint = {cfg.origin.x + 1, cfg.origin.y + 2};
  const char *mapKey = map.entries[2].key;
  volatile int mapValue = map.entries[2].value;
  volatile int mapCount = map.count;
  volatile int mapped = map.get("three");
  volatile int mapKeyTag = mapKey ? static_cast<int>(mapKey[0]) : 0;
  Accumulator acc;
  int total = acc.sum(localBuf, 3);
  g_counter = total + mapped + mapValue + mapCount + mapKeyTag + localPoint.x +
              localPoint.y + cfg.id;
  volatile int *bad = reinterpret_cast<volatile int *>(0x0);
  *bad = g_counter;
  return total;
}

__attribute__((noinline)) int level2(int seed) {
  int localArr[4];
  const int count = static_cast<int>(sizeof(g_values) / sizeof(g_values[0]));
  for (int i = 0; i < 4; i++) {
    localArr[i] = g_values[(seed + i) % count];
  }
  int pairValue = g_pairs[seed % 4].value;
  Config cfg = g_config;
  cfg.id += seed + pairValue;
  cfg.scale *= 1.1f;
  return level3(g_map, cfg, localArr, 4);
}

__attribute__((noinline)) void level1() {
  int seed = 3;
  int result = level2(seed);
  Serial.println(result);
}

void setup() {
  Serial.begin(9600);
  Serial.println("vars_demo setup");
}

void loop() {
  static bool once = false;
  if (!once) {
    once = true;
    level1();
  }
  delay(1000);
}
