#!/usr/bin/env python3
# NeoPixel library strandtest example
# Author: Tony DiCola (tony@tonydicola.com)
#
# Direct port of the Arduino NeoPixel library strandtest example.  Showcases
# various animations on a strip of NeoPixels.

import asyncio
from contextlib import ExitStack
import time
import math
import neopixel
from rpi_ws281x import *
import board
import argparse
from message import *
import random
from multiprocessing import Process, Queue
import enum

# LED strip configuration:
LED_COUNT      = 100    # Number of LED pixels.
LED_PIN        = 18      # GPIO pin connected to the pixels (18 uses PWM!).
#LED_PIN        = 10      # GPIO pin connected to the pixels (10 uses SPI /dev/spidev0.0).
LED_FREQ_HZ    = 800000  # LED signal frequency in hertz (usually 800khz)
LED_DMA        = 10      # DMA channel to use for generating a signal (try 10)
LED_BRIGHTNESS = 0.20
LED_INVERT     = False   # True to invert the signal (when using NPN transistor level shift)
LED_CHANNEL    = 0       # set to '1' for GPIOs 13, 19, 41, 45 or 53
STRIP_FRAMERATE = 60

EXTRA_LATENCY = 1.0 / STRIP_FRAMERATE + 0.010


# Define functions which animate LEDs in various ways.
def colorWipe(strip, color, wait_ms=10):
    """Wipe color across display a pixel at a time."""
    for i in range(strip.numPixels()):
        strip[i] =  color
        strip.show()
        asyncio.sleep(wait_ms/1000.0)

def theaterChase(strip, color, wait_ms=10, iterations=10):
    """Movie theater light style chaser animation."""
    for j in range(iterations):
        for q in range(3):
            for i in range(0, strip.numPixels(), 3):
                strip[i+q] = color
            strip.show()
            asyncio.sleep(wait_ms/1000.0)
            for i in range(0, strip.numPixels(), 3):
                strip[i+q] = 0

def wheel(pos):
    """Generate rainbow colors across 0-255 positions."""
    if pos < 85:
        return Color(pos * 3, 255 - pos * 3, 0)
    elif pos < 170:
        pos -= 85
        return Color(255 - pos * 3, 0, pos * 3)
    else:
        pos -= 170
        return Color(0, pos * 3, 255 - pos * 3)

def rainbow(strip, wait_ms=20, iterations=1):
    """Draw rainbow that fades across all pixels at once."""
    for j in range(256*iterations):
        for i in range(strip.numPixels()):
            strip[i] = wheel((i+j) & 255)
        strip.show()
        asyncio.sleep(wait_ms/1000.0)

def rainbowCycle(strip, wait_ms=20, iterations=5):
    """Draw rainbow that uniformly distributes itself across all pixels."""
    for j in range(256*iterations):
        for i in range(strip.numPixels()):
            strip[i] = wheel((int(i * 256 / strip.numPixels()) + j) & 255)
        strip.show()
        asyncio.sleep(wait_ms/1000.0)

def theaterChaseRainbow(strip, wait_ms=10):
    """Rainbow movie theater light style chaser animation."""
    for j in range(256):
        for q in range(3):
            for i in range(0, strip.numPixels(), 3):
                strip[i+q] = wheel((i+j) % 255)
            strip.show()
            asyncio.sleep(wait_ms/1000.0)
            for i in range(0, strip.numPixels(), 3):
                strip[i + q] = 0

LED_COUNT      = 600    # Number of LED pixels.
LED_PIN        = board.pin.D18      # GPIO pin connected to the pixels (18 uses PWM!).
#LED_PIN        = 10      # GPIO pin connected to the pixels (10 uses SPI /dev/spidev0.0).
LED_FREQ_HZ    = 800000  # LED signal frequency in hertz (usually 800khz)
LED_DMA        = 10      # DMA channel to use for generating a signal (try 10)
LED_INVERT     = False   # True to invert the signal (when using NPN transistor level shift)
LED_CHANNEL    = 0       # set to '1' for GPIOs 13, 19, 41, 45 or 53


CHASE_PERIOD = 2

class LedStrip(neopixel.NeoPixel):
    class Mode(enum.IntEnum):
        WIPE = enum.auto()
        CHASE = enum.auto()
        RAINBOW = enum.auto()
        RAINBOW_CYCLE = enum.auto()
        ALL_IN = enum.auto()
        MAX = enum.auto()

    def __init__(self):
        super().__init__(n=LED_COUNT, pin=LED_PIN, brightness=LED_BRIGHTNESS, auto_write=False)
        self.mode = LedStrip.Mode.WIPE
        self.num_leds = 600
        self.cur_brush_color = Color(0, 0, 255)
        self.cur_wheel_pos = 0
        self.cur_sync_rate_hz = 120 / 60 * 24
        self.background_tasks = set()
        self.update_n = 0
        self.updates_since_beat = 0
        self.beat = 0

    def update_step(self):
        if self.mode == LedStrip.Mode.WIPE:
            step = 4
            num_steps = (self.num_leds + step - 1) // step
            for i in range(num_steps - 1, 0, -1):
                for j in range(0, step):
                    if (i * step + j) < self.num_leds:
                        self[i * step + j] = self[(i - 1) * step + j]
            for j in range(0, step):
                self[j] = self.cur_brush_color
        elif self.mode == LedStrip.Mode.ALL_IN:
            for i in range(0, self.num_leds):
                self[i] = self.cur_brush_color
        elif self.mode == LedStrip.Mode.CHASE and self.update_n % CHASE_PERIOD == 0:
            for i in range(0, self.num_leds):
                self[i] = self.cur_brush_color if i % 2 == (self.update_n // CHASE_PERIOD) % 2 else Color(0, 0, 0)
        elif self.mode == LedStrip.Mode.RAINBOW:
            for i in range(0, self.num_leds):
                self[i] = wheel((i + self.update_n) & 0xFF)
        elif self.mode == LedStrip.Mode.RAINBOW_CYCLE:
            for i in range(0, self.num_leds):
                self[i] = wheel(int(i * 256 / self.num_leds + self.update_n) & 0xFF)

        self.update_n += 1
        self.updates_since_beat += 1

    def update(self, msg):

        async def wait_then_update_color(strip, new_color, sched_time):
            sleep_time = max(0, sched_time - time.time())
            await asyncio.sleep(sleep_time)
            strip.cur_brush_color = new_color
            strip.updates_since_beat = 0

        if msg.msg_type == Msg.Type.BEAT and msg.channel == 1:
            self.cur_wheel_pos = int(256 * random.random())
            delay = 1.0 / (self.cur_sync_rate_hz / 24) / 2.0
            sched_time = msg.t + delay - EXTRA_LATENCY
            #sched_time = 0
            new_color = wheel(self.cur_wheel_pos)
            task = asyncio.create_task(wait_then_update_color(self, new_color, sched_time))
            self.background_tasks.add(task)
            task.add_done_callback(self.background_tasks.discard)

        elif msg.msg_type == Msg.Type.SYNC:
            self.cur_sync_rate_hz = msg.sync_rate_hz

        elif msg.msg_type == Msg.Type.PROGRAM_CHANGE:
            print('change program')
            self.mode = LedStrip.Mode(random.randint(1, LedStrip.Mode.MAX - 1))
            self.update_n = 0


    def hide(self):
        for i in range(0, self.num_leds):
            self[i] = Color(0, 0, 0)
        self.show()


strip = LedStrip()
strip.cur_mode = LedStrip.Mode.ALL_IN
async def led_update_loop():
    while True:
        strip.update_step()
        strip.show()
        await asyncio.sleep(1.0 / STRIP_FRAMERATE)

async def led_handle_msgs(queue):
    background_tasks = set()
    try:
        while True:
            msg = await queue.get()
            strip.update(msg)
    finally:
        strip.hide()

