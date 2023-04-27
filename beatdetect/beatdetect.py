import jack
import numpy as np
import sys
import time
import matplotlib.pyplot as plt
import matplotlib.animation as animation
import queue

# Create a queue to pass data from the process function to the main thread
data_queue = queue.Queue()

# Create new figure and two subplots, sharing both axes
fig, (ax1, ax2) = plt.subplots(2, sharex=True, sharey=True)

# Create two numpy arrays of zeros of size of your buffer
buffer_size = 1024  # Modify if using a different buffer size
x_left = []
x_right = []
y_left = []
y_right = []

# Create two line objects for visualisation
line_left, = ax1.plot(x_left, y_left, label='Channel 1')
line_right, = ax2.plot(x_right, y_right, label='Channel 2')

# Setting the axis properties
ax1.set_ylim([-1, 1])
ax2.set_ylim([-1, 1])
ax1.set_xlim([0, buffer_size])
ax2.set_xlim([0, buffer_size])
ax1.legend(loc='upper right')
ax2.legend(loc='upper right')

def process(frames):
    # Calculate the time of each frame
    t = np.arange(client.last_frame_time, client.last_frame_time + frames) / client.samplerate

    # Get the audio data
    data = np.empty((2, frames), dtype=np.float32)
    np.copyto(data[0], client.inports[0].get_array())
    np.copyto(data[1], client.inports[1].get_array())

    # Put the time and data in the queue
    data_queue.put((t, data))

client = jack.Client("Data_Recorder")

# Register the process callback
client.set_process_callback(process)

# Create two input ports for stereo input
client.inports.register("input_1")
client.inports.register("input_2")

with client:
    usbmic_ports = client.get_ports("usbmic", is_audio=True, is_output=True)

    if not usbmic_ports:
        print("No usbmic output ports found", file=sys.stderr)
        sys.exit(1)

    for source, destination in zip(usbmic_ports, client.inports):
        client.connect(source, destination)

    # Show the plot and start updating
    plt.ion()
    plt.show()

    print("Press Ctrl+C to stop")
    try:
        while True:
            if not data_queue.empty():
                t, data = data_queue.get()
                # Update line data
                # Append the time and data to the x and y lists
                x_left.extend(t)
                x_right.extend(t)
                y_left.extend(data[0])
                y_right.extend(data[1])

                # Update line data
                line_left.set_data(x_left, y_left)
                line_right.set_data(x_right, y_right)

                # Rescale the x-axis to fit the new data
                ax1.set_xlim([x_left[0], x_left[-1]])
                ax2.set_xlim([x_right[0], x_right[-1]])

                # Redraw
                fig.canvas.draw()
                fig.canvas.flush_events()

            time.sleep(0.01)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
