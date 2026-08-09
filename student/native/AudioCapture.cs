using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.Wave;

internal sealed class Pcm16Resampler
{
    private const int TargetRate = 16000;
    private const int PacketSamples = 3200;
    private readonly WaveFormat sourceFormat;
    private readonly double ratio;
    private readonly List<float> pending = new List<float>();
    private readonly short[] packet = new short[PacketSamples];
    private int packetOffset;
    private double readPosition;
    private readonly Stream output;

    public Pcm16Resampler(WaveFormat sourceFormat, Stream output)
    {
        this.sourceFormat = Normalize(sourceFormat);
        this.output = output;
        ratio = (double)this.sourceFormat.SampleRate / TargetRate;
        if (this.sourceFormat.Channels < 1 || this.sourceFormat.SampleRate < TargetRate)
            throw new InvalidOperationException("Unsupported audio format: " + this.sourceFormat);
    }

    private static WaveFormat Normalize(WaveFormat format)
    {
        WaveFormatExtensible extensible = format as WaveFormatExtensible;
        return extensible == null ? format : extensible.ToStandardWaveFormat();
    }

    public void Write(byte[] buffer, int count)
    {
        int bytesPerSample = sourceFormat.BitsPerSample / 8;
        int frameBytes = bytesPerSample * sourceFormat.Channels;
        if (bytesPerSample < 2 || frameBytes <= 0) throw new InvalidOperationException("Unsupported audio format: " + sourceFormat);

        for (int offset = 0; offset + frameBytes <= count; offset += frameBytes)
        {
            float mono = 0;
            for (int channel = 0; channel < sourceFormat.Channels; channel++)
                mono += ReadSample(buffer, offset + channel * bytesPerSample, bytesPerSample);
            pending.Add(mono / sourceFormat.Channels);
        }

        while (readPosition + 1 < pending.Count)
        {
            int left = (int)readPosition;
            double fraction = readPosition - left;
            double sample = pending[left] * (1 - fraction) + pending[left + 1] * fraction;
            sample = Math.Max(-1, Math.Min(1, sample));
            packet[packetOffset++] = (short)Math.Round(sample < 0 ? sample * 32768 : sample * 32767);
            readPosition += ratio;
            if (packetOffset == PacketSamples) FlushPacket();
        }

        int consumed = Math.Min((int)readPosition, Math.Max(0, pending.Count - 1));
        if (consumed > 0)
        {
            pending.RemoveRange(0, consumed);
            readPosition -= consumed;
        }
    }

    private float ReadSample(byte[] buffer, int offset, int bytesPerSample)
    {
        if (sourceFormat.Encoding == WaveFormatEncoding.IeeeFloat && bytesPerSample == 4)
            return BitConverter.ToSingle(buffer, offset);
        if (sourceFormat.Encoding != WaveFormatEncoding.Pcm)
            throw new InvalidOperationException("Unsupported audio encoding: " + sourceFormat.Encoding);
        if (bytesPerSample == 2) return BitConverter.ToInt16(buffer, offset) / 32768f;
        if (bytesPerSample == 3)
        {
            int value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
            if ((value & 0x800000) != 0) value |= unchecked((int)0xff000000);
            return value / 8388608f;
        }
        if (bytesPerSample == 4) return BitConverter.ToInt32(buffer, offset) / 2147483648f;
        throw new InvalidOperationException("Unsupported PCM bit depth: " + sourceFormat.BitsPerSample);
    }

    private void FlushPacket()
    {
        byte[] bytes = new byte[PacketSamples * 2];
        Buffer.BlockCopy(packet, 0, bytes, 0, bytes.Length);
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
        packetOffset = 0;
    }
}

internal static class Program
{
    private static WasapiLoopbackCapture capture;
    private static MMDevice device;
    private static readonly ManualResetEvent stopped = new ManualResetEvent(false);
    private static Exception captureError;

    private static string JsonString(string value)
    {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '\\': result.Append("\\\\"); break;
                case '"': result.Append("\\\""); break;
                case '\r': result.Append("\\r"); break;
                case '\n': result.Append("\\n"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 32) result.Append("\\u" + ((int)character).ToString("x4"));
                    else result.Append(character);
                    break;
            }
        }
        return result.Append('"').ToString();
    }

    private static void Status(string eventName, string message, WaveFormat format)
    {
        string formatFields = format == null ? "" :
            ",\"sampleRate\":" + format.SampleRate + ",\"channels\":" + format.Channels + ",\"bits\":" + format.BitsPerSample;
        Console.Error.WriteLine("{\"event\":" + JsonString(eventName) + ",\"message\":" + JsonString(message) +
            ",\"device\":" + JsonString(device == null ? null : device.FriendlyName) + formatFields + "}");
        Console.Error.Flush();
    }

    public static int Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        try
        {
            device = WasapiLoopbackCapture.GetDefaultLoopbackCaptureDevice();
            capture = new WasapiLoopbackCapture(device);
            Pcm16Resampler resampler = new Pcm16Resampler(capture.WaveFormat, Console.OpenStandardOutput());
            capture.DataAvailable += delegate(object sender, WaveInEventArgs args)
            {
                try { resampler.Write(args.Buffer, args.BytesRecorded); }
                catch (Exception error) { captureError = error; stopped.Set(); }
            };
            capture.RecordingStopped += delegate(object sender, StoppedEventArgs args)
            {
                if (args.Exception != null) captureError = args.Exception;
                stopped.Set();
            };
            capture.StartRecording();
            Status("ready", "WASAPI loopback capture started", capture.WaveFormat);

            Thread inputThread = new Thread(delegate()
            {
                try { Console.In.ReadLine(); }
                catch { }
                stopped.Set();
            });
            inputThread.IsBackground = true;
            inputThread.Start();
            stopped.WaitOne();
            capture.StopRecording();
            if (captureError != null) throw captureError;
            Status("stopped", "Capture stopped", null);
            return 0;
        }
        catch (Exception error)
        {
            Status("error", error.Message, null);
            return 1;
        }
        finally
        {
            if (capture != null) capture.Dispose();
            if (device != null) device.Dispose();
        }
    }
}
