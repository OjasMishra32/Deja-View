// ?xremu=1 : installs the iwer WebXR emulator (Meta Quest 3 profile) so the XR code path runs
// in desktop Chrome. The device is exposed as window.__xrDevice for scripted tests.

export async function installXrEmulator(): Promise<unknown> {
  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3, { stereoEnabled: true });
  device.installRuntime({ forceInstall: true });
  (window as unknown as { __xrDevice: unknown }).__xrDevice = device;
  return device;
}
