import CoreAudio
import Foundation

struct AudioProcess: Encodable {
    let pid: Int32
    let runningOutput: Bool
}

func audioProcesses() throws -> [AudioProcess] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size)
    guard status == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if objects.isEmpty { return [] }
    status = objects.withUnsafeMutableBytes { buffer in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, buffer.baseAddress!)
    }
    guard status == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return objects.compactMap { object in
        var pid: Int32 = 0
        var pidSize = UInt32(MemoryLayout<Int32>.size)
        var pidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(object, &pidAddress, 0, nil, &pidSize, &pid) == noErr, pid > 0 else { return nil }
        var output: UInt32 = 0
        var outputSize = UInt32(MemoryLayout<UInt32>.size)
        var outputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningOutput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        _ = AudioObjectGetPropertyData(object, &outputAddress, 0, nil, &outputSize, &output)
        return AudioProcess(pid: pid, runningOutput: output != 0)
    }
}

do {
    let data = try JSONEncoder().encode(audioProcesses())
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
} catch {
    FileHandle.standardError.write(Data("Cannot enumerate Core Audio processes: \(error)\n".utf8))
    exit(1)
}
