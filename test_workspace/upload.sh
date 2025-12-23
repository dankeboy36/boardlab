#!/bin/sh

./arduino-cli \
  upload \
  --fqbn esp32:esp32:esp32da \
  --port /dev/cu.usbserial-0001 \
  plotter \
  --verbose
