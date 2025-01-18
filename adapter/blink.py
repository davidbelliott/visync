#!/usr/bin/env python3
# NeoPixel library strandtest example
# Author: Tony DiCola (tony@tonydicola.com)
#
# Direct port of the Arduino NeoPixel library strandtest example.  Showcases
# various animations on a strip of NeoPixels.

import asyncio
from contextlib import ExitStack
import time
import neopixel
import board
import argparse
from message import *
import random
from multiprocessing import Process, Queue

# LED strip configuration:
LED_COUNT      = 600    # Number of LED pixels.
LED_PIN        = 18      # GPIO pin connected to the pixels (18 uses PWM!).
#LED_PIN        = 10      # GPIO pin connected to the pixels (10 uses SPI /dev/spidev0.0).
LED_FREQ_HZ    = 800000  # LED signal frequency in hertz (usually 800khz)
LED_DMA        = 10      # DMA channel to use for generating a signal (try 10)
LED_BRIGHTNESS = 1      # Set to 0 for darkest and 255 for brightest
LED_INVERT     = False   # True to invert the signal (when using NPN transistor level shift)
LED_CHANNEL    = 0       # set to '1' for GPIOs 13, 19, 41, 45 or 53



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
        return (pos * 3, 255 - pos * 3, 0)
    elif pos < 170:
        pos -= 85
        return (255 - pos * 3, 0, pos * 3)
    else:
        pos -= 170
        return (0, pos * 3, 255 - pos * 3)

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
                strip.setPixelColor(i+q, wheel((i+j) % 255))
            strip.show()
            asyncio.sleep(wait_ms/1000.0)
            for i in range(0, strip.numPixels(), 3):
                strip.setPixelColor(i+q, 0)

MODE_WIPE = 0
MODE_CHASE = 1
MODE_RAINBOW = 2
MODE_RAINBOW_CYCLE = 3
MODE_ALL_IN = 4

LED_COUNT      = 600    # Number of LED pixels.
LED_PIN        = board.pin.D18      # GPIO pin connected to the pixels (18 uses PWM!).
#LED_PIN        = 10      # GPIO pin connected to the pixels (10 uses SPI /dev/spidev0.0).
LED_FREQ_HZ    = 800000  # LED signal frequency in hertz (usually 800khz)
LED_DMA        = 10      # DMA channel to use for generating a signal (try 10)
LED_INVERT     = False   # True to invert the signal (when using NPN transistor level shift)
LED_CHANNEL    = 0       # set to '1' for GPIOs 13, 19, 41, 45 or 53

EXTRA_LATENCY = 0


class LedStrip(neopixel.NeoPixel):
    def __init__(self):
        super().__init__(n=LED_COUNT, pin=LED_PIN, brightness=0.05, auto_write=False)
        self.cur_mode = MODE_ALL_IN
        self.cur_pixel_idx = 0
        self.num_leds = 600
        self.cur_brush_color = (0, 0, 255)
        self.cur_wheel_pos = 0
        self.cur_sync_rate_hz = 120 / 60 * 24
        self.background_tasks = set()

    def update_step(self):
        if self.cur_mode == MODE_WIPE:
            self[0] = self.cur_brush_color
            for i in range(1, self.num_leds):
                self[i] = self[i - 1]
        if self.cur_mode == MODE_ALL_IN:
            for i in range(0, self.num_leds):
                self[i] = self.cur_brush_color
            self.cur_pixel_idx = 0

    def update(self, msg):
        if msg.msg_type == Msg.Type.BEAT and msg.channel == 1:
            self.cur_wheel_pos = (self.cur_wheel_pos + 40) % 256
            delay = 1.0 / self.cur_sync_rate_hz * 24 / 2 - EXTRA_LATENCY
            task = asyncio.create_task(wait_then_update_color(self, wheel(self.cur_wheel_pos), delay))
            self.background_tasks.add(task)
            task.add_done_callback(self.background_tasks.discard)

            print("new color")
        elif msg.msg_type == Msg.Type.SYNC:
            self.cur_sync_rate_hz = msg.sync_rate_hz


    def hide(self):
        for i in range(0, self.num_leds):
            self.setPixelColor(i, Color(0, 0, 0))
        self.show()

# In your main process:
led_queue = Queue()
def led_process_function():
    strip = LedStrip()  # Initialize LED strip in this process
    while True:
        print('updating')
        update = led_queue.get()
        if update is None:  # Shutdown signal
            break
        strip.cur_brush_color = update['color']
        strip.update_step()
        strip.show()


async def wait_then_update_color(strip, new_color, delay):
    print('trying to update')
    await asyncio.sleep(delay)
    strip.cur_brush_color = new_color
    strip.update_step()
    try:
        led_queue.put({'color': new_color}, block=False)
    except Queue.Full:
        print('full queue')
    print('updating color')

async def led_update_loop(queue):
    strip = LedStrip()
    led_process = Process(target=led_process_function)
    led_process.start()
    strip.cur_mode = MODE_WIPE
    background_tasks = set()
    try:
        while True:
            '''print ('Color wipe animations.')
            colorWipe(strip, Color(255, 0, 0), 0)  # Red wipe
            colorWipe(strip, Color(0, 255, 0), 0)  # Blue wipe
            colorWipe(strip, Color(0, 0, 255), 0)  # Green wipe
            print ('Theater chase animations.')
            theaterChase(strip, Color(127, 127, 127), 50)  # White theater chase
            theaterChase(strip, Color(127,   0,   0), 50)  # Red theater chase
            theaterChase(strip, Color(  0,   0, 127), 50)  # Blue theater chase
            print ('Rainbow animations.')
            rainbow(strip)
            rainbowCycle(strip)
            theaterChaseRainbow(strip, 50)'''
            while True:
                msg = await queue.get()
                if msg.msg_type == Msg.Type.BEAT and msg.channel == 1:
                    strip.cur_wheel_pos = (strip.cur_wheel_pos + 40) % 256
                    delay = 1.0 / cur_sync_rate_hz * 24 / 2 - EXTRA_LATENCY
                    task = asyncio.create_task(wait_then_update_color(strip, wheel(strip.cur_wheel_pos), delay))
                    background_tasks.add(task)
                    task.add_done_callback(background_tasks.discard)

                    print("new color")
                elif msg.msg_type == Msg.Type.SYNC:
                    cur_sync_rate_hz = msg.sync_rate_hz

            '''strip.update_step()
            strip.show()
            wait_ms = 3
            await asyncio.sleep(wait_ms/1000.0)'''
    finally:
        strip.hide()

