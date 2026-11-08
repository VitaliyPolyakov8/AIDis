// AIDis application audio capture helper (0.4.5).
//
// Captures the audio of ONE process (and its child processes) with the documented Windows
// "process loopback" API (ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
// Windows 10 build 20348+ / Windows 11). This is the same supported API the Windows SDK
// "ApplicationLoopback" sample uses. It only reads what Windows mixes for that process:
// nothing is injected into the game, no hooks, no memory access, no drivers.
//
// Usage: aidis-app-audio.exe --hwnd <window handle>   (or --pid <process id>)
// Output (stdout): raw interleaved float32 stereo PCM at 48 kHz, written as it arrives.
// Messages (stderr): one line "ready <pid>" once capture runs, or "error <code> <what>".
// Exit: when stdin is closed (the parent app went away) or on error.
//
// Build: see build.cmd (MSVC, Windows SDK; no extra libraries).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl/implements.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

static void fail(const char* what, HRESULT hr) {
  fprintf(stderr, "error 0x%08lx %s\n", static_cast<unsigned long>(hr), what);
  fflush(stderr);
  ExitProcess(2);
}

class ActivationHandler : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_FAIL;
  ComPtr<IAudioClient> client;

  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activateResult = E_FAIL;
    ComPtr<IUnknown> unknown;
    HRESULT hr = op->GetActivateResult(&activateResult, &unknown);
    result = FAILED(hr) ? hr : activateResult;
    if (SUCCEEDED(result)) result = unknown.As(&client);
    SetEvent(done);
    return S_OK;
  }
};

// Parent closed our stdin: stop.
static DWORD WINAPI watchStdin(LPVOID) {
  char buf[64];
  DWORD read = 0;
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  while (ReadFile(in, buf, sizeof(buf), &read, nullptr) && read > 0) {
  }
  ExitProcess(0);
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  DWORD pid = 0;
  for (int i = 1; i + 1 < argc; i += 1) {
    if (wcscmp(argv[i], L"--pid") == 0) pid = static_cast<DWORD>(_wtoi64(argv[i + 1]));
    if (wcscmp(argv[i], L"--hwnd") == 0) {
      HWND hwnd = reinterpret_cast<HWND>(static_cast<INT_PTR>(_wtoi64(argv[i + 1])));
      GetWindowThreadProcessId(hwnd, &pid);
    }
  }
  if (pid == 0) fail("no target process", E_INVALIDARG);
  _setmode(_fileno(stdout), _O_BINARY);
  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) fail("CoInitializeEx", hr);

  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT activateParams = {};
  activateParams.vt = VT_BLOB;
  activateParams.blob.cbSize = sizeof(params);
  activateParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  ComPtr<ActivationHandler> handler = Microsoft::WRL::Make<ActivationHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activateParams, handler.Get(), &op);
  if (FAILED(hr)) fail("ActivateAudioInterfaceAsync", hr);
  WaitForSingleObject(handler->done, INFINITE);
  if (FAILED(handler->result)) fail("activate process loopback", handler->result);
  ComPtr<IAudioClient> client = handler->client;

  // Process loopback has no mix format of its own: we ask for 48 kHz float stereo.
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 32;
  format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                          200000 /* 20 ms */, 0, &format, nullptr);
  if (FAILED(hr)) fail("IAudioClient::Initialize", hr);
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  hr = client->SetEventHandle(ready);
  if (FAILED(hr)) fail("SetEventHandle", hr);
  ComPtr<IAudioCaptureClient> capture;
  hr = client->GetService(IID_PPV_ARGS(&capture));
  if (FAILED(hr)) fail("GetService(IAudioCaptureClient)", hr);
  hr = client->Start();
  if (FAILED(hr)) fail("Start", hr);
  fprintf(stderr, "ready %lu\n", static_cast<unsigned long>(pid));
  fflush(stderr);

  std::vector<float> silence;
  for (;;) {
    if (WaitForSingleObject(ready, 2000) != WAIT_OBJECT_0) continue;
    UINT32 frames = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&frames)) && frames > 0) {
      BYTE* data = nullptr;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) fail("GetBuffer", hr);
      const size_t bytes = static_cast<size_t>(frames) * format.nBlockAlign;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(static_cast<size_t>(frames) * 2, 0.0f);
        fwrite(silence.data(), 1, bytes, stdout);
      } else {
        fwrite(data, 1, bytes, stdout);
      }
      capture->ReleaseBuffer(frames);
    }
    fflush(stdout);
  }
}
