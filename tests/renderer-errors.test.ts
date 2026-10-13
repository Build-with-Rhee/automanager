import { describe, expect, it } from "vitest";
import { errorText } from "../src/renderer/errors";

describe("desktop error messages", () => {
  it("shows the actionable message without Electron's IPC wrapper", () => {
    const failure = new Error(
      "Error invoking remote method 'automanager:invoke': Error: 마이크 사용 권한이 필요합니다.",
    );
    expect(errorText(failure)).toBe("마이크 사용 권한이 필요합니다.");
  });

  it("preserves ordinary errors and strips the wrapper from string failures", () => {
    expect(errorText(new Error("설정 저장에 실패했습니다."))).toBe(
      "설정 저장에 실패했습니다.",
    );
    expect(
      errorText(
        'Error invoking remote method "automanager:invoke": 선택한 마이크가 연결되지 않았습니다.',
      ),
    ).toBe("선택한 마이크가 연결되지 않았습니다.");
    expect(
      errorText("Error invoking remote method is a user-entered message"),
    ).toBe("Error invoking remote method is a user-entered message");
  });
});
