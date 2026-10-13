{
  "targets": [{
    "target_name": "windows_context",
    "sources": ["windows_context.cc"],
    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
    "defines": ["NAPI_VERSION=8", "NAPI_CPP_EXCEPTIONS", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
    "libraries": ["user32.lib", "ole32.lib", "oleaut32.lib", "uiautomationcore.lib"],
    "msvs_settings": { "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] } },
    "conditions": [["OS!='win'", { "type": "none" }]]
  }]
}
