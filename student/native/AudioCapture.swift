import AudioToolbox
import CoreMedia
import Foundation
import ScreenCaptureKit

private let targetSampleRate = 16_000.0
private let packetSamples = 3_200

private func writeStatus(_ event: String, message: String, extra: [String: Any] = [:]) {
    var payload: [String: Any] = ["event": event, "message": message]
    extra.forEach { payload[$0.key] = $0.value }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line.append("\n")
    FileHandle.standardError.write(Data(line.utf8))
}

private final class PacketWriter {
    private var pending = Data()

    func append(_ samples: [Int16]) {
        samples.withUnsafeBytes { pending.append(contentsOf: $0) }
        let packetBytes = packetSamples * MemoryLayout<Int16>.size
        while pending.count >= packetBytes {
            FileHandle.standardOutput.write(pending.prefix(packetBytes))
            pending.removeFirst(packetBytes)
        }
    }
}

private final class Pcm16Resampler {
    private let packetWriter: PacketWriter
    private var pending = [Float]()
    private var readPosition = 0.0
    private var sourceSampleRate = 0.0

    init(packetWriter: PacketWriter) {
        self.packetWriter = packetWriter
    }

    func append(_ source: [Float], sampleRate: Double) {
        guard sampleRate > 0 else { return }
        if sourceSampleRate != sampleRate {
            sourceSampleRate = sampleRate
            pending.removeAll(keepingCapacity: true)
            readPosition = 0
        }
        pending.append(contentsOf: source)

        let ratio = sourceSampleRate / targetSampleRate
        var output = [Int16]()
        output.reserveCapacity(Int(Double(source.count) / ratio) + 1)
        while readPosition + 1 < Double(pending.count) {
            let left = Int(readPosition)
            let fraction = Float(readPosition - Double(left))
            let value = max(-1.0, min(1.0, pending[left] * (1 - fraction) + pending[left + 1] * fraction))
            output.append(Int16(value < 0 ? value * 32768.0 : value * 32767.0))
            readPosition += ratio
        }

        let consumed = min(Int(readPosition), max(0, pending.count - 1))
        if consumed > 0 {
            pending.removeFirst(consumed)
            readPosition -= Double(consumed)
        }
        packetWriter.append(output)
    }
}

private final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let outputQueue = DispatchQueue(label: "cn.internal.interviewassistant.audio")
    private let packetWriter = PacketWriter()
    private lazy var resampler = Pcm16Resampler(packetWriter: packetWriter)
    private var stream: SCStream?
    private var stopped = false

    func start() async throws -> String {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false,
            onScreenWindowsOnly: true
        )
        guard let display = content.displays.first else {
            throw NSError(
                domain: "InterviewAudioCapture",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No display is available for system audio capture"]
            )
        }

        let filter = SCContentFilter(
            display: display,
            excludingApplications: [],
            exceptingWindows: []
        )
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = Int(targetSampleRate)
        configuration.channelCount = 1
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.showsCursor = false
        configuration.queueDepth = 3

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: outputQueue)
        self.stream = stream
        try await stream.startCapture()
        return display.displayID.description
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        guard let stream else { return }
        try? await stream.stopCapture()
        self.stream = nil
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        guard !stopped else { return }
        stopped = true
        writeStatus("error", message: error.localizedDescription)
        exit(1)
    }

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType
    ) {
        guard outputType == .audio,
              sampleBuffer.isValid,
              sampleBuffer.dataReadiness == .ready,
              let format = sampleBuffer.formatDescription,
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return }

        guard description.mFormatID == kAudioFormatLinearPCM else {
            writeStatus("error", message: "ScreenCaptureKit returned an unsupported audio format")
            Task { await stop(); exit(1) }
            return
        }

        var bufferList = AudioBufferList()
        var blockBuffer: CMBlockBuffer?
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &bufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr, let rawData = bufferList.mBuffers.mData else { return }

        let frameCount = sampleBuffer.numSamples
        let isFloat = description.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let isNonInterleaved = description.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let bitsPerChannel = Int(description.mBitsPerChannel)
        let channels = Int(description.mChannelsPerFrame)
        guard channels > 0, channels == 1 || !isNonInterleaved else {
            writeStatus("error", message: "ScreenCaptureKit returned unsupported planar multichannel audio")
            Task { await stop(); exit(1) }
            return
        }
        var samples = [Float]()
        samples.reserveCapacity(frameCount)

        if isFloat && bitsPerChannel == 32 {
            let values = rawData.assumingMemoryBound(to: Float.self)
            for index in 0..<frameCount {
                var mono: Float = 0
                for channel in 0..<channels { mono += values[index * channels + channel] }
                samples.append(mono / Float(channels))
            }
        } else if !isFloat && bitsPerChannel == 16 {
            let values = rawData.assumingMemoryBound(to: Int16.self)
            for index in 0..<frameCount {
                var mono: Float = 0
                for channel in 0..<channels {
                    mono += Float(values[index * channels + channel]) / 32768.0
                }
                samples.append(mono / Float(channels))
            }
        } else {
            writeStatus("error", message: "ScreenCaptureKit returned an unsupported PCM representation")
            Task { await stop(); exit(1) }
            return
        }

        resampler.append(samples, sampleRate: description.mSampleRate)
    }
}

@main
private enum InterviewAudioCapture {
    static func main() async {
        let capture = SystemAudioCapture()
        do {
            let display = try await capture.start()
            writeStatus(
                "ready",
                message: "ScreenCaptureKit system audio capture started",
                extra: ["device": "Display \(display)", "sampleRate": 16_000, "channels": 1, "bits": 16]
            )
            await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .utility).async {
                    _ = readLine()
                    continuation.resume()
                }
            }
            await capture.stop()
            writeStatus("stopped", message: "Capture stopped")
        } catch {
            writeStatus("error", message: error.localizedDescription)
            exit(1)
        }
    }
}
