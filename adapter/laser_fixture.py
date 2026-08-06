from PyDMXControl.profiles.defaults import Fixture

# LaserAdvanced represent a single channel of the uking zq05031 laser
# There are 2 laser channels: one from 0-17, two from 18-35
# Power to the entire system is controlled by the first laser channel
# Pattern group selection seems to be only controlled by the first laser channel
class LaserAdvanced(Fixture):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        # 0       Laser off
        # 1-99    auto
        # 100-199 sound active
        # 200-254 saving?
        # 255     Pattern A off
        self._register_channel('on_off') # CH1

        # 0-49    out of bounds crossing
        # 50-99   out of bounds reentry
        # 100-149 out of bounds blanking
        # 150-199 pattern zoom out
        # 200-255 saving?
        self._register_channel('bounds_pattern') # CH2

        # 0-223   group 1
        # 244-255 group 0
        self._register_channel('group_selection') # CH3

        # 0-255   each value is a pattern up to group max 
        # group 0 0-127
        # group 1 0-255
        # Look at end of the file for description of patterns
        self._register_channel('pattern_selection') # CH4

        # 0-127   Static pattern size
        # 128-159 dynamic zoom out
        # 160-191 dynamic zoom in
        # 192-223 dynamic zoom in/out
        # 224-255 dynamic zoom rotation
        self._register_channel('pattern_zoom') # CH5

        # 0-127   Static rotation
        # 128-159 dynamic rotation 2 clockwise 2 cclockwise 
        # 160-191 dynamic rotation 1 clockwise 1 cclockwise
        # 192-223 dynamic rotation clockwise
        # 224-255 dynamic rotation cclockwise
        self._register_channel('pattern_rotation') # CH6

        # 0-127   Static x moving
        # 128-159 dynamic up wave effect
        # 160-191 dynamic down wave effect
        # 192-223 dynamic left
        # 224-255 dynamic right
        self._register_channel('x_moving') # CH7

        # 0-127   Static y moving
        # 128-159 dynamic right wave effect
        # 160-191 dynamic left wave effect
        # 192-223 dynamic down
        # 224-255 dynamic up
        self._register_channel('y_moving') # CH8

        # 0-127   Static size
        # 128-159 dynamic up distortion
        # 160-191 dynamic down distortion
        # 192-223 dynamic in/out
        # 224-255 dynamic rotation zoom in/out
        self._register_channel('x_zoom') # CH9

        # 0-127   Static size
        # 128-159 dynamic right distortion
        # 160-191 dynamic left distortion
        # 192-223 dynamic in/out
        # 224-255 dynamic rotation zoom in/out
        self._register_channel('y_zoom') # CH10

        # 0       original color
        # 1-255   color change with each n dot
        self._register_channel('fixed_color') # CH11

        # 0-7     original color
        # 8-15    red
        # 16-23   yellow
        # 24-31   green
        # 32-39   cyan
        # 40-47   blue
        # 48-55   pink
        # 56-63   white
        # 64-95   whole pattern RGB
        # 96-127  whole pattern YCP
        # 128-159 whole pattern RGBYCPW
        # 160-191 7 color RGBYCPW
        # 192-223 sine chasing color change
        # 224-255 cosine chasing color change
        self._register_channel('pattern_color') # CH12

        # 0-63    original dots
        # 64-127  pattern no dots effect, sweep line blanking
        # 128-159 pattern no dots effect, sweep line no blanking
        # 160-255 saving?
        self._register_channel('dots') # CH13

        # 0-127   pattern moving drawing all on to keep the time ?
        # 128-255 walking drawing line quantity ?
        self._register_channel('drawing') # CH14

        # 0-63    sine manual drawing
        # 64-127  cosine manual drawing
        # 128-159 dynamic drawing A effect
        # 160-191 dynamic drawing B effect
        # 192-223 dynamic drawing C effect
        # 224-255 dynamic drawing D effect
        self._register_channel('drawing2') # CH15

        # 0-255   Twisting
        self._register_channel('twist_pattern') # CH16

        # 0-19    Grating group larger digit -> smaller pattern?
        # 20-39
        # 40-59
        # ???
        # 240-255
        self._register_channel('grating_selection') # CH17


# Description of patterns on channel 4
# group 0
# 0,25      Circle 5 color segments
# 1         Star multi color segements
# 2         Circle 4 color segments
# 3         Circle many dots
# 4,5,7     Circle solid green
# 6         Circle multi color
# 8         Line diagonal / two color
# 9         2 circle multi color
# 10,11     Circle 3 color multi segment
# 12,42     C shaped 3 sides
# 13        Circle 3 color
# 14        Circle few dots
# 15        Square dots
# 16,48     Single white dot
# 17        Octagon without top
# 18        Circle small white
# 19,37,43  Line horizontal multi color
# 20,36,124 3 circle
# 21        Spiral
# 22,23     Line horizontal multi segment
# 24        Line vertical multi segment
# 26        Line horizontal small
# 27,122    Blank??
# 28        Circle in circle
# 29        Circle of circles
# 30,121    Square large white
# 31        Line diagonal \ solid
# 32,44     Triangle dots
# 33,56     2 horizontal lines
# 34,35,57  Line horizontal dots
# 38        Line diagonal / small
# 39,76     Line diagonal / large
# 40,41     Semi circle top
# 45,49     Line horizontal solid
# 46        Line diagonal \ dots
# 47        2 Line diagonal / small
# 50        4 stars
# 51        Sine wave
# 52        2 circle horizontal
# 53,69,71  Square multi color
# 54        Star solid green
# 55        M multi color
# 58-68     3 dots different locations
# 70        4 lines in square
# 72        4 V in X shape
# 73        Octagon
# 74        Octagon without side
# 75        Triangle white
# 77        5 horizontal lines rainbow
# 78        Bunch of dots
# 79        7 circles in diagonal line \
# 80-96     Mitosis
# 97-120    Wormhole
# 123       Triangle 3 color
# 125       Diamond
# 126       Square multi color large
# 127       2 V top + bottom

# group 1
# 0-30    Dolphin
# 31-47   Ostrich
# 48-55   Winnie-Pooh
# 56      Butterfly
# 57      Flower
# 58-73   Hand dropping stuff
# 74-128  Flying hearts
# 129-148 Dancing girl pink shirt
# 149-196 Belly dancer
# 197-255 Dancing guy red jacket