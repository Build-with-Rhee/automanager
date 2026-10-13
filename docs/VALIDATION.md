# 실행 검증 기록

2026-10-13, Linux x64 / Node 24 / Electron 44.7.0에서 실행했다. Windows 결과와 실제 하드웨어 입력의 결과는 포함하지 않는다.

| 검사 | 결과와 범위 |
| --- | --- |
| 단위·통합 로직 | 세션 저장, WAV 분할/복구, 프로세스/입력, 검증 IPC, 큐 취소/세대, 재개, worker 종료 등 실제 테스트 실행 |
| React UI | 11개 Playwright 흐름 통과: 시작/정지, 검토, 검색/삭제, 주석, 모델/엔진, 예약, 오류, 키보드/좁은 화면, 지연된 응답, 화면 표시 |
| 실제 Electron 녹음 | Chromium 합성 마이크로 창 닫기→125초 백그라운드→일시정지/재개→종료. WAV 10개, 2,005,120 샘플(125.32초). 물리 마이크 품질 검증은 아님 |
| 재개 회귀 | 느린 OS worker 준비 중 PCM이 거절되는 실패를 재현하고 상태 전이 순서를 수정. 이후 Electron 검사에서 재개 후 21,376개 새 샘플 확인 |
| 실제 화면 | 합성 영상 장치 플래그를 제거한 별도 Electron에서 X11 데스크톱 캡처·주석 영역 저장 통과. `docs/screenshots/automanager-real-screen.jpg` |
| 실제 전역 입력 | Xvfb/Openbox의 별도 Electron 테스트 창에 XTest Tab과 왼쪽 클릭(130,150)을 전송. 실제 창 제목·PID 문맥을 가진 단계 수신, 오류 없음. Linux 문맥은 sampled로 표시 |
| 실제 음성 | Melo 한국어와 Kokoro af_heart WAV 생성. 생성한 한국어 음성을 16 kHz로 변환하고 실제 whisper.cpp 모델로 인식 |
| 한국어 인식 결과 | `안녕하세요. 오토 매니저는 작업과 음성을 함께 기록합니다.` |
| 이동한 엔진 | 공식 해시를 검증한 portable CPython을 이동한 뒤 두 TTS 재실행. 상대 RPATH의 Whisper 이동 후 `안녕하세요. 이동한 엔진을 확인합니다.` 인식 |
| 실제 worker 종료 | Electron 저장 utility process를 종료한 뒤 후속 snapshot이 즉시 오류를 반환하고 앱이 정상 종료됨. 무한 대기 회귀 수정 |
| 패키지 실행 | `release/linux-unpacked/automanager` 실행에서 renderer, 모델 목록, DB worker 준비 검사 통과. Linux x64 tar.gz 생성 |

첫 자동화 검사에는 합성 마이크 설정이 화면에도 적용되어 Chromium 테스트 영상이 잡혔다. 이를 실제 데스크톱 캡처의 증거로 사용하지 않았으며, 합성 장치를 끈 별도 검사를 위 표의 화면 결과로 사용한다.

리뷰에서 재현한 재개 시 PCM 손실, 종료한 저장 worker의 후속 명령 무한 대기, 200개 terminal job 목록 밖으로 밀려난 취소 작업의 자동 재실행을 실패 테스트로 고정하고 수정했다. 화면의 raw 전역 좌표를 다시 그리는 중복 overlay도 제거했다.

Windows MSVC addon 빌드·실행, Windows 설치물·UI Automation·다중 모니터/DPI·UAC/잠금 화면, 물리 마이크/장치 분리·GPU 가속은 아직 실행 검증하지 않았다. Windows CI 경로를 추가했지만 이 작업에서는 push나 워크플로 실행을 하지 않았다. Linux 결과로 해당 검증을 대체하지 않는다.
