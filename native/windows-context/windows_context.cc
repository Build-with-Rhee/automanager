#include <napi.h>
#include <windows.h>
// WIN32_LEAN_AND_MEAN omits the COM declarations required by UIAutomation.h.
#include <objbase.h>
#include <UIAutomation.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_set>

namespace {
struct Event {
  std::string type, key;
  HWND window = nullptr;
  DWORD processId = 0;
  std::wstring title, appName;
  double timestamp = 0;
  LONG x = 0, y = 0;
  int button = 0, rotation = 0;
  bool horizontal = false, ctrl = false, alt = false, shift = false, meta = false;
  unsigned dropped = 0;
  unsigned long long sequence = 0;
};
struct HookState {
  Napi::ThreadSafeFunction callback;
  std::thread thread;
  std::atomic<DWORD> threadId{0};
  HHOOK mouse = nullptr, keyboard = nullptr;
  std::mutex mutex;
  std::condition_variable ready;
  bool initialized = false;
  DWORD error = 0;
  std::atomic<unsigned> dropped{0};
  std::atomic<bool> stopRequested{false};
  unsigned long long sequence = 0;
  std::unique_ptr<Napi::Promise::Deferred> stopDeferred;
  std::unordered_set<DWORD> forwardedKeys;
};
std::unique_ptr<HookState> hooks;

double EpochMilliseconds() {
  FILETIME time;
  GetSystemTimeAsFileTime(&time);
  ULARGE_INTEGER value;
  value.LowPart = time.dwLowDateTime; value.HighPart = time.dwHighDateTime;
  return static_cast<double>(value.QuadPart - 116444736000000000ULL) / 10000.0;
}
Napi::String Wide(Napi::Env env, const std::wstring& value) {
  return Napi::String::New(env, reinterpret_cast<const char16_t*>(value.data()), value.size());
}
std::string KeyName(DWORD key) {
  if (key >= 'A' && key <= 'Z') return std::string(1, static_cast<char>(key));
  if (key >= '0' && key <= '9') return std::string(1, static_cast<char>(key));
  if (key >= VK_F1 && key <= VK_F24) return "F" + std::to_string(key - VK_F1 + 1);
  if (key >= VK_NUMPAD0 && key <= VK_NUMPAD9) return "Numpad" + std::to_string(key - VK_NUMPAD0);
  switch (key) {
    case VK_RETURN: return "Enter"; case VK_TAB: return "Tab";
    case VK_ESCAPE: return "Escape"; case VK_BACK: return "Backspace";
    case VK_DELETE: return "Delete"; case VK_INSERT: return "Insert";
    case VK_HOME: return "Home"; case VK_END: return "End";
    case VK_PRIOR: return "PageUp"; case VK_NEXT: return "PageDown";
    case VK_UP: return "ArrowUp"; case VK_DOWN: return "ArrowDown";
    case VK_LEFT: return "ArrowLeft"; case VK_RIGHT: return "ArrowRight";
    case VK_SNAPSHOT: return "PrintScreen"; case VK_PAUSE: return "Pause";
    case VK_SPACE: return "Space"; case VK_OEM_1: return "Semicolon";
    case VK_OEM_PLUS: return "Equal"; case VK_OEM_COMMA: return "Comma";
    case VK_OEM_MINUS: return "Minus"; case VK_OEM_PERIOD: return "Period";
    case VK_OEM_2: return "Slash"; case VK_OEM_3: return "Backquote";
    case VK_OEM_4: return "BracketLeft"; case VK_OEM_5: return "Backslash";
    case VK_OEM_6: return "BracketRight"; case VK_OEM_7: return "Quote";
    case VK_ADD: return "NumpadAdd"; case VK_SUBTRACT: return "NumpadSubtract";
    case VK_MULTIPLY: return "NumpadMultiply"; case VK_DIVIDE: return "NumpadDivide";
    case VK_DECIMAL: return "NumpadDecimal";
    default: return "";
  }
}
void Snapshot(Event& event, HWND window) {
  event.window = window ? GetAncestor(window, GA_ROOT) : nullptr;
  if (!event.window) return;
  GetWindowThreadProcessId(event.window, &event.processId);
  wchar_t title[401] = {};
  GetWindowTextW(event.window, title, 400);
  event.title = title;
  // Process executable lookup is deferred to the metadata helper, away from this hook.
  event.appName = L"Process " + std::to_wstring(event.processId);
}
std::wstring ProcessName(DWORD processId) {
  std::wstring name;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (process) {
    wchar_t path[32768] = {}; DWORD size = 32768;
    if (QueryFullProcessImageNameW(process, 0, path, &size)) {
      std::wstring full(path, size);
      auto slash = full.find_last_of(L"\\/");
      name = full.substr(slash == std::wstring::npos ? 0 : slash + 1);
    }
    CloseHandle(process);
  }
  return name;
}
void Dispatch(std::unique_ptr<Event> event) {
  event->sequence = ++hooks->sequence;
  event->dropped = hooks->dropped.exchange(0);
  Event* pointer = event.release();
  napi_status status = hooks->callback.NonBlockingCall(pointer, [](Napi::Env env, Napi::Function callback, Event* value) {
    std::unique_ptr<Event> owned(value);
    if (!env || !callback) return;
    auto event = Napi::Object::New(env);
    event.Set("type", value->type); event.Set("timestamp", value->timestamp);
    event.Set("eventId", "windows-" + std::to_string(value->sequence));
    event.Set("contextQuality", value->window ? "event-time" : "unavailable");
    event.Set("dropped", value->dropped);
    if (value->window) {
      auto context = Napi::Object::New(env);
      context.Set("handle", std::to_string(reinterpret_cast<uintptr_t>(value->window)));
      context.Set("processId", value->processId); context.Set("appName", Wide(env, value->appName));
      context.Set("title", Wide(env, value->title)); context.Set("capturedAt", value->timestamp);
      event.Set("context", context);
    } else event.Set("context", env.Null());
    if (!value->key.empty()) event.Set("key", value->key);
    else { event.Set("x", value->x); event.Set("y", value->y); event.Set("button", value->button); }
    if (value->type == "wheel") {
      event.Set("rotation", value->rotation);
      event.Set("direction", value->horizontal ? "horizontal" : "vertical");
    }
    auto modifiers = Napi::Object::New(env);
    modifiers.Set("ctrl", value->ctrl); modifiers.Set("alt", value->alt);
    modifiers.Set("shift", value->shift); modifiers.Set("meta", value->meta);
    event.Set("modifiers", modifiers);
    callback.Call({event});
  });
  if (status != napi_ok) { hooks->dropped.fetch_add(1 + pointer->dropped); delete pointer; }
}
LRESULT CALLBACK MouseHook(int code, WPARAM message, LPARAM data) {
  if (code == HC_ACTION && hooks) {
    const auto* mouse = reinterpret_cast<MSLLHOOKSTRUCT*>(data);
    auto event = std::make_unique<Event>();
    switch (message) {
      case WM_LBUTTONDOWN: event->type = "mousedown"; event->button = 1; break;
      case WM_LBUTTONUP: event->type = "mouseup"; event->button = 1; break;
      case WM_RBUTTONDOWN: event->type = "mousedown"; event->button = 2; break;
      case WM_RBUTTONUP: event->type = "mouseup"; event->button = 2; break;
      case WM_MBUTTONDOWN: event->type = "mousedown"; event->button = 3; break;
      case WM_MBUTTONUP: event->type = "mouseup"; event->button = 3; break;
      case WM_MOUSEWHEEL: case WM_MOUSEHWHEEL:
        event->type = "wheel"; event->rotation = static_cast<SHORT>(HIWORD(mouse->mouseData));
        event->horizontal = message == WM_MOUSEHWHEEL; break;
      default: return CallNextHookEx(nullptr, code, message, data);
    }
    event->timestamp = EpochMilliseconds(); event->x = mouse->pt.x; event->y = mouse->pt.y;
    // Freeze the hit window before Windows dispatches the click and changes foreground.
    Snapshot(*event, WindowFromPoint(mouse->pt));
    Dispatch(std::move(event));
  }
  return CallNextHookEx(nullptr, code, message, data);
}
LRESULT CALLBACK KeyboardHook(int code, WPARAM message, LPARAM data) {
  if (code == HC_ACTION && hooks) {
    const auto* key = reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
    auto event = std::make_unique<Event>();
    event->key = KeyName(key->vkCode);
    event->ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
    event->alt = (key->flags & LLKHF_ALTDOWN) != 0;
    event->shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
    event->meta = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
    const bool character = (key->vkCode >= '0' && key->vkCode <= 'Z') || key->vkCode == VK_SPACE ||
      (key->vkCode >= VK_NUMPAD0 && key->vkCode <= VK_DIVIDE) || key->vkCode >= VK_OEM_1;
    const bool released = message == WM_KEYUP || message == WM_SYSKEYUP;
    // Ordinary characters never cross the native-to-JavaScript boundary.
    if (event->key.empty() || (character && !(event->ctrl || event->alt || event->meta) && !(released && hooks->forwardedKeys.count(key->vkCode)))) return CallNextHookEx(nullptr, code, message, data);
    if (released) hooks->forwardedKeys.erase(key->vkCode);
    else hooks->forwardedKeys.insert(key->vkCode);
    event->type = released ? "keyup" : "keydown";
    event->timestamp = EpochMilliseconds();
    Snapshot(*event, GetForegroundWindow());
    Dispatch(std::move(event));
  }
  return CallNextHookEx(nullptr, code, message, data);
}
void HookLoop() {
  hooks->threadId = GetCurrentThreadId();
  MSG message;
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  HMODULE module = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
    reinterpret_cast<LPCWSTR>(&MouseHook), &module);
  hooks->mouse = SetWindowsHookExW(WH_MOUSE_LL, MouseHook, module, 0);
  hooks->keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardHook, module, 0);
  {
    std::lock_guard<std::mutex> lock(hooks->mutex);
    if (!hooks->mouse || !hooks->keyboard) { hooks->error = GetLastError(); if (!hooks->error) hooks->error = ERROR_INVALID_HANDLE; }
    hooks->initialized = true;
  }
  hooks->ready.notify_one();
  if (hooks->mouse && hooks->keyboard && !hooks->stopRequested.load()) {
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
  }
  if (hooks->mouse) UnhookWindowsHookEx(hooks->mouse);
  if (hooks->keyboard) UnhookWindowsHookEx(hooks->keyboard);
  hooks->callback.Release();
}
Napi::Value Start(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  if (hooks || info.Length() < 1 || !info[0].IsFunction()) { Napi::Error::New(env, "Native input hook already started or callback missing.").ThrowAsJavaScriptException(); return env.Undefined(); }
  hooks = std::make_unique<HookState>();
  hooks->callback = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "automanager-windows-input", 128, 1,
    [](Napi::Env env) {
      if (env && hooks && hooks->stopDeferred) {
        auto drained = Napi::Object::New(env); drained.Set("dropped", hooks->dropped.load());
        hooks->stopDeferred->Resolve(drained);
      }
      if (hooks && hooks->thread.joinable()) hooks->thread.join();
      hooks.reset();
    });
  hooks->thread = std::thread(HookLoop);
  std::unique_lock<std::mutex> lock(hooks->mutex);
  const bool ready = hooks->ready.wait_for(lock, std::chrono::seconds(2), [] { return hooks->initialized; });
  const DWORD error = hooks->error;
  lock.unlock();
  if (!ready || error) {
    hooks->stopRequested.store(true);
    PostThreadMessageW(hooks->threadId.load(), WM_QUIT, 0, 0);
    if (hooks->thread.joinable()) hooks->thread.join();
    Napi::Error::New(env, "Windows input hook initialization failed (" + std::to_string(error) + ").").ThrowAsJavaScriptException();
  }
  return env.Undefined();
}
Napi::Value Stop(const Napi::CallbackInfo& info) {
  auto deferred = Napi::Promise::Deferred::New(info.Env());
  if (!hooks) { auto drained = Napi::Object::New(info.Env()); drained.Set("dropped", 0); deferred.Resolve(drained); return deferred.Promise(); }
  hooks->stopDeferred = std::make_unique<Napi::Promise::Deferred>(deferred);
  hooks->stopRequested.store(true);
  PostThreadMessageW(hooks->threadId.load(), WM_QUIT, 0, 0);
  if (hooks->thread.joinable()) hooks->thread.join();
  // ThreadSafeFunction finalization resolves after all accepted native events drain.
  return deferred.Promise();
}

Napi::Value GetElement(const Napi::CallbackInfo& info) {
  auto env = info.Env(); auto result = Napi::Object::New(env); result.Set("unavailable", true);
  if (info.Length() < 5 || !info[0].IsString() || !info[1].IsNumber()) return result;
  HWND expected = nullptr;
  try { expected = reinterpret_cast<HWND>(static_cast<uintptr_t>(std::stoull(info[0].As<Napi::String>().Utf8Value()))); } catch (...) { return result; }
  const DWORD expectedPid = info[1].As<Napi::Number>().Uint32Value();
  DWORD actualPid = 0;
  if (!IsWindow(expected) || !GetWindowThreadProcessId(expected, &actualPid) || actualPid != expectedPid) return result;
  result.Set("appName", Wide(env, ProcessName(expectedPid)));
  const bool keyboard = info[4].As<Napi::Boolean>().Value();
  if (keyboard && GetAncestor(GetForegroundWindow(), GA_ROOT) != expected) return result;
  POINT point{info[2].As<Napi::Number>().Int32Value(), info[3].As<Napi::Number>().Int32Value()};
  if (!keyboard && GetAncestor(WindowFromPoint(point), GA_ROOT) != expected) return result;
  // UI Automation runs only in the separately killable helper process.
  HRESULT initialized = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(initialized)) return result;
  IUIAutomation* automation = nullptr;
  IUIAutomationElement* element = nullptr;
  HRESULT status = CoCreateInstance(__uuidof(CUIAutomation), nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation), reinterpret_cast<void**>(&automation));
  if (SUCCEEDED(status)) status = keyboard ? automation->GetFocusedElement(&element) : automation->ElementFromPoint(point, &element);
  if (SUCCEEDED(status) && element) {
    int processId = 0; BOOL password = TRUE; CONTROLTYPEID type = 0;
    const bool sameProcess = SUCCEEDED(element->get_CurrentProcessId(&processId)) && static_cast<DWORD>(processId) == expectedPid;
    if (sameProcess && SUCCEEDED(element->get_CurrentIsPassword(&password)) && SUCCEEDED(element->get_CurrentControlType(&type))) {
      // Names of editable/document/text controls can contain input; omit them too.
      const bool omitName = password || type == UIA_EditControlTypeId || type == UIA_DocumentControlTypeId || type == UIA_TextControlTypeId;
      BSTR name = nullptr, role = nullptr;
      if (!omitName) element->get_CurrentName(&name);
      element->get_CurrentLocalizedControlType(&role);
      result.Set("unavailable", false); result.Set("password", password != FALSE);
      if (name) { result.Set("name", Wide(env, std::wstring(name, SysStringLen(name)).substr(0, 160))); SysFreeString(name); }
      if (role) { result.Set("controlType", Wide(env, std::wstring(role, SysStringLen(role)).substr(0, 50))); SysFreeString(role); }
    }
  }
  if (element) element->Release();
  if (automation) automation->Release();
  CoUninitialize();
  return result;
}
Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("getElement", Napi::Function::New(env, GetElement));
  return exports;
}
}
NODE_API_MODULE(windows_context, Initialize)
