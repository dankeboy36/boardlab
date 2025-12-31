#!/bin/sh

./arduino-cli \
  monitor \
  --fqbn esp32:esp32:esp32da \
  --port /dev/cu.usbserial-0001 \
  --config baudrate=9600
