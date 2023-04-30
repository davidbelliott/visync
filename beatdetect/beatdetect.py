import numpy as np
import queue
import jack
import time

import matplotlib.pyplot as plt
import matplotlib.colors as colors


import numpy as np
import scipy.signal
import scipy.stats

def estimate_bpm(fft_results, bin_length_seconds):
    # Convert the FFT results to mono amplitude over time for each bin
    amplitude = np.sum(np.abs(fft_results), axis=1).T
    #amplitude[amplitude < np.mean(amplitude) + np.std(amplitude)] = 0

    # Compute the autocorrelation of each bin
    autocorr = np.array([scipy.signal.correlate(bin_data, bin_data, mode='full') for bin_data in amplitude])

    # Only keep the second half of the autocorrelation (the first half is symmetric)
    autocorr = autocorr[:, len(autocorr[0]) // 2:]

    # Average the autocorrelation across all bins to get a single autocorrelation function
    #avg_autocorr = autocorr.mean(axis=0)

    # Find the peak in the autocorrelation between 90 and 180 BPM
    bpm_range = (90 / 4, 140 / 4)
    frame_range = (int(60 / bpm_range[1] / bin_length_seconds), int(60 / bpm_range[0] / bin_length_seconds))
    peak_frames = [np.argmax(x[frame_range[0]:frame_range[1]]) + frame_range[0] \
            for x in autocorr]


    print(peak_frames)
    # fit the parameters of norm distribution
    peak_frame = scipy.stats.mode(peak_frames, keepdims=False).mode
    # Convert the frame number of the peak to BPM
    peak_bpm = 60 / (peak_frame * bin_length_seconds) * 4

    return peak_bpm

F_MAX = 3e3

def plot_fft_heatmap(fft_results, frequencies, num_points):
    # Convert the FFT results to mono amplitude over time for each bin
    amplitude = np.sum(np.abs(fft_results), axis=1).T
    # amplitude[amplitude < np.mean(amplitude) + 2 * np.std(amplitude)] = 0
    # Create an empty 2D array to store the amplitude of each bin over time

    # Calculate the time and frequency arrays for the plot
    time = np.arange(len(fft_results)) * T

    # Create the heatmap plot
    fig, (ax1, ax2) = plt.subplots(2, sharex=True, sharey=True)
    im1 = ax1.pcolormesh(time, frequencies, amplitude, shading='auto', cmap='viridis')
    im2 = ax2.pcolormesh(time, frequencies, amplitude, shading='auto', cmap='viridis')

    # Set the axis labels and colorbars
    ax1.set_ylabel("Frequency (Hz)")
    ax1.set_title("Channel 1")
    fig.colorbar(im1, ax=ax1)
    ax2.set_xlabel("Time (s)")
    ax2.set_ylabel("Frequency (Hz)")
    ax2.set_title("Channel 2")
    fig.colorbar(im2, ax=ax2)

    # Show the plot
    plt.show()

# The length of each FFT bin in seconds
#T = 0.01  # For example, 0.1 seconds
#T = 60.0 / 170.0 * 4.0 / 32.0
T = 10e-3

sweep_bin_divisions = 10    # subdivide each bin into this many starting points

# Create a queue to pass data from the process function to the main thread
data_queue = queue.Queue()

# Create a list to hold the FFT results
fft_results = []

def process(frames):
    # Get the audio data
    data = np.empty((2, frames), dtype=np.float32)
    np.copyto(data[0], client.inports[0].get_array())
    np.copyto(data[1], client.inports[1].get_array())

    # Put the data in the queue
    data_queue.put(data)

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

    # Calculate the number of frames per bin
    frames_per_bin = int(T * client.samplerate)
    frames_per_sub_bin = int(frames_per_bin / sweep_bin_divisions)

    # Compute the frequency of each bin
    frequencies = np.fft.rfftfreq(frames_per_bin, 1 / client.samplerate)

    # Find the index of the highest frequency bin we're interested in
    max_index = np.searchsorted(frequencies, F_MAX, side='right')

    # Create a buffer to hold the incoming data until we have enough for a bin
    buffer = np.empty((2, 0), dtype=np.float32)

    print("Press Ctrl+C to stop")
    try:
        while True:
            if not data_queue.empty():
                data = data_queue.get()

                # Add the new data to the buffer
                buffer = np.hstack((buffer, data))

                # If we have enough data for a bin, compute the FFT and remove the data from the buffer
                while buffer.shape[1] >= frames_per_bin:
                    bin_data = buffer[:, :frames_per_bin]
                    buffer = buffer[:, frames_per_sub_bin:]

                    # Compute the FFT of the bin data
                    fft_bin = np.fft.rfft(bin_data, frames_per_bin, axis=1)

                    # Discard the frequency bins above f
                    fft_bin = fft_bin[:, :max_index]

                    # Add the FFT result to the list
                    fft_results.append(fft_bin)

            time.sleep(0.01)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        plot_fft_heatmap(fft_results, frequencies[:max_index], frames_per_bin)

        # Example usage
        bpm = estimate_bpm(fft_results, T / sweep_bin_divisions)
        print("Estimated BPM:", bpm)
