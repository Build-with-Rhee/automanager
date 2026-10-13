import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Headphones,
  LayoutDashboard,
  LoaderCircle,
  MessageSquare,
  Mic,
  MicOff,
  Minus,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  Waves,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  AppSnapshot,
  DesktopAPI,
  Job,
  ModelInfo,
  Rect,
  Schedule,
  Session,
  SessionDetail,
  Settings,
  Step,
} from "../shared/types";
import { requestMicrophone } from "../capture/devices";
import { errorText } from "./errors";
import "./styles.css";

type View =
  | "overview"
  | "library"
  | "transcription"
  | "voice"
  | "schedules"
  | "settings"
  | "detail";
const nav: Array<{ id: View; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "개요", icon: LayoutDashboard },
  { id: "library", label: "기록 라이브러리", icon: Folder },
  { id: "transcription", label: "음성 변환", icon: AudioLines },
  { id: "voice", label: "음성 만들기", icon: Waves },
  { id: "schedules", label: "예약", icon: CalendarClock },
  { id: "settings", label: "설정", icon: Settings2 },
];
const statusNames: Record<string, string> = {
  recording: "기록 중",
  paused: "일시정지",
  completed: "완료",
  interrupted: "중단됨",
  queued: "대기 중",
  running: "변환 중",
  failed: "실패",
  canceled: "취소됨",
  processing: "변환 중",
  done: "변환 완료",
  saved: "녹음 저장됨",
};
const formatTime = (milliseconds: number) => {
  const sec = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
};
const duration = (ms: number) =>
  ms >= 3600000
    ? `${Math.floor(ms / 3600000)}시간 ${Math.floor(ms / 60000) % 60}분`
    : ms >= 60000
      ? `${Math.floor(ms / 60000)}분`
      : `${Math.floor(ms / 1000)}초`;
const date = (value: number) =>
  new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
const size = (bytes: number) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.round(bytes / 1e6)} MB`;

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
function Button({
  children,
  className = "",
  tone = "secondary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button {...props} className={`button ${tone} ${className}`}>
      {children}
    </button>
  );
}
function IconButton({
  icon: Icon,
  label,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      {...props}
      title={label}
      aria-label={label}
      className={`icon-button ${props.className || ""}`}
    >
      <Icon size={18} strokeWidth={1.7} />
    </button>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <span className="status-dot" />
      {statusNames[status] || status}
    </span>
  );
}
function Toggle({
  label,
  checked,
  onChange,
  disabled,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <div className="toggle-row">
      <div>
        <span>{label}</span>
        {description && <p>{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        className={`toggle ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}
function Empty({
  icon: Icon = FolderOpen,
  title = "아직 기록이 없어요",
  description = "첫 기록을 시작하면 작업과 음성이 이곳에 차곡차곡 쌓여요.",
  action,
}: {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-illustration">
        <span className="empty-ring" />
        <div className="empty-icon">
          <Icon size={30} strokeWidth={1.35} />
        </div>
        <span className="empty-spark">✦</span>
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Dialog({
  title,
  description,
  children,
  onClose,
  wide,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first =
      ref.current?.querySelector<HTMLElement>("input, textarea, select") ||
      ref.current?.querySelector<HTMLElement>("button");
    first?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const all = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]',
        ) || []),
      ];
      const first = all[0];
      const last = all[all.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", listener);
    return () => {
      document.removeEventListener("keydown", listener);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <header>
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon={X} label="닫기" onClick={onClose} />
        </header>
        {children}
      </div>
    </div>
  );
}

function App() {
  const api = window.automanager as DesktopAPI | undefined;
  const [state, setState] = useState<AppSnapshot | null>(null);
  const [view, setView] = useState<View>("overview");
  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = useRef<string | null>(null);
  const detailRequest = useRef(0);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [showStart, setShowStart] = useState(false);
  const [comment, setComment] = useState(false);
  const [rename, setRename] = useState<Session | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [tick, setTick] = useState(Date.now());
  const clock = useRef({ at: Date.now(), durationMs: 0 });
  const run = useCallback(
    async <T,>(
      work: () => Promise<T>,
      success?: string,
    ): Promise<T | undefined> => {
      setPending((value) => value + 1);
      setError(null);
      try {
        const result = await work();
        if (success) setToast(success);
        return result;
      } catch (error) {
        setError(errorText(error));
        return undefined;
      } finally {
        setPending((value) => value - 1);
      }
    },
    [],
  );
  useEffect(() => {
    if (!api) return;
    let alive = true;
    api
      .snapshot()
      .then((value) => {
        if (alive) setState(value);
      })
      .catch((error) => {
        if (alive) setError(errorText(error));
      });
    const unsubscribe = api.onState((value) => {
      if (alive) setState(value);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(id);
  }, [toast]);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const fetchDetail = useCallback(
    async (id: string) => {
      if (!api) return;
      const request = ++detailRequest.current;
      try {
        const value = await api.getSession(id);
        if (selectedId.current === id && request === detailRequest.current)
          setDetail(value);
      } catch (error) {
        if (selectedId.current === id && request === detailRequest.current)
          setError(errorText(error));
      }
    },
    [api],
  );
  useEffect(() => {
    if (selected && api) void fetchDetail(selected);
  }, [selected, state, api, fetchDetail]);
  const openSession = (session: Session) => {
    selectedId.current = session.id;
    setSelected(session.id);
    setView("detail");
    setDetail(null);
  };
  const navigate = (id: View) => {
    setView(id);
    if (id !== "detail") {
      selectedId.current = null;
      setSelected(null);
    }
  };
  const start = async (title: string, audio: boolean, screen: boolean) => {
    if (!api) return;
    const value = await run(() =>
      api.startSession({ title: title.trim(), audio, screen }),
    );
    if (value) {
      setShowStart(false);
      await openSession(value);
    }
  };
  const active = state?.activeSession;
  useEffect(() => {
    clock.current = { at: Date.now(), durationMs: active?.durationMs || 0 };
  }, [active?.id, active?.status, active?.durationMs]);
  const activeDuration = active
    ? clock.current.durationMs +
      (active.status === "recording" ? Math.max(0, tick - clock.current.at) : 0)
    : 0;
  if (!api)
    return (
      <div className="connection-screen">
        <BrandMark />
        <h1>Automanager</h1>
        <p>작업과 음성을 한 타임라인에.</p>
        <div className="connection-card">
          <Monitor size={28} />
          <h2>데스크톱 앱에서 시작해 주세요</h2>
          <p>기록과 로컬 파일은 Automanager 데스크톱 앱에 안전하게 보관돼요.</p>
        </div>
      </div>
    );
  const title =
    view === "detail"
      ? "기록 라이브러리"
      : nav.find((item) => item.id === view)?.label || "개요";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <span>
            automanager
            <span className="brand-caption">YOUR WORK, REMEMBERED</span>
          </span>
        </div>
        <div className="workspace-label">
          내 워크스페이스 <ChevronDown size={14} />
        </div>
        <nav aria-label="주 탐색">
          {nav.map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              className={`nav-item ${view === item.id || (view === "detail" && item.id === "library") ? "selected" : ""}`}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} strokeWidth={1.7} />
              <span>{item.label}</span>
              {item.id === "transcription" &&
                !!state?.jobs.filter(
                  (job) => job.status === "queued" || job.status === "running",
                ).length && (
                  <span className="nav-count">
                    {
                      state.jobs.filter(
                        (job) =>
                          job.status === "queued" || job.status === "running",
                      ).length
                    }
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={18} />
            <div>
              내 컴퓨터에 안전하게<span>기록은 로컬에 저장돼요</span>
            </div>
          </div>
          <button className="profile" onClick={() => navigate("settings")}>
            <span className="avatar">A</span>
            <span>
              나의 작업 공간<small>개인 워크스페이스</small>
            </span>
            <Settings2 size={16} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            워크스페이스 <ChevronRight size={14} />
            <span>{title}</span>
          </div>
          <div className="top-actions">
            <span className="shortcut-hint">
              <kbd>Ctrl</kbd>
              <span>+</span>
              <kbd>Shift</kbd>
              <span>+</span>
              <kbd>R</kbd>
            </span>
            <Button
              tone="primary"
              disabled={!!active || pending > 0 || !state}
              onClick={() => setShowStart(true)}
            >
              <Plus size={17} />새 기록
            </Button>
            <div className="window-actions">
              <IconButton
                icon={Minus}
                label="창 최소화"
                onClick={() => api.minimize()}
              />
              <IconButton
                icon={Square}
                label="창 최대화"
                onClick={() => api.maximize()}
              />
              <IconButton
                icon={X}
                label="트레이로 숨기기"
                onClick={() => api.closeWindow()}
              />
            </div>
          </div>
        </header>
        <main
          className={`content ${view === "detail" ? "detail-content" : ""}`}
        >
          {(error || state?.recordingError) && (
            <div
              role="alert"
              className={`error-banner ${showStart || comment || rename || deleting ? "modal-error" : ""}`}
            >
              <span>
                <Activity size={18} />
                {error || state?.recordingError}
              </span>
              <IconButton
                icon={X}
                label="오류 닫기"
                onClick={() => {
                  setError(null);
                }}
              />
            </div>
          )}
          {!state ? (
            <div className="loading">
              <LoaderCircle className="spin" size={28} />
              <p>
                {error
                  ? "데스크톱 연결을 확인해 주세요."
                  : "작업 공간을 불러오는 중이에요"}
              </p>
              {error && (
                <Button
                  onClick={() =>
                    void run(() => api.snapshot()).then(
                      (value) => value && setState(value),
                    )
                  }
                >
                  다시 연결
                </Button>
              )}
            </div>
          ) : (
            <>
              {view === "overview" && (
                <Overview
                  state={state}
                  durationMs={activeDuration}
                  onStart={() => setShowStart(true)}
                  onOpen={openSession}
                  onLibrary={() => navigate("library")}
                  onSettings={() => navigate("settings")}
                  onPause={() =>
                    void run(() =>
                      active?.status === "paused"
                        ? api.resumeSession()
                        : api.pauseSession(),
                    )
                  }
                  onStop={() =>
                    void run(
                      () => api.stopSession(),
                      "기록을 안전하게 저장했어요.",
                    )
                  }
                />
              )}
              {view === "library" && (
                <Library
                  state={state}
                  api={api}
                  onOpen={openSession}
                  onStart={() => setShowStart(true)}
                  onRename={setRename}
                  onDelete={setDeleting}
                  onExport={(id) =>
                    void run(() => api.exportSession(id)).then(
                      (path) =>
                        path && setToast("기록을 ZIP 파일로 내보냈어요."),
                    )
                  }
                />
              )}
              {view === "detail" && (
                <SessionReview
                  detail={detail}
                  api={api}
                  active={active?.id === selected}
                  onBack={() => navigate("library")}
                  onRename={setRename}
                  onDelete={setDeleting}
                  onComment={() => setComment(true)}
                  onExport={() =>
                    selected &&
                    void run(() => api.exportSession(selected)).then(
                      (path) =>
                        path && setToast("기록을 ZIP 파일로 내보냈어요."),
                    )
                  }
                  onTranscribe={() =>
                    selected &&
                    void run(
                      () => api.transcribe(selected),
                      "음성 변환 대기열에 추가했어요.",
                    )
                  }
                />
              )}
              {view === "transcription" && (
                <Transcription
                  state={state}
                  api={api}
                  run={run}
                  onOpen={openSession}
                  onSettings={() => navigate("settings")}
                />
              )}
              {view === "voice" && (
                <VoiceStudio
                  state={state}
                  api={api}
                  run={run}
                  onSettings={() => navigate("settings")}
                />
              )}
              {view === "schedules" && (
                <Schedules state={state} api={api} run={run} />
              )}
              {view === "settings" && (
                <SettingsView state={state} api={api} run={run} />
              )}
            </>
          )}
          <div className="page-footnote">
            <span>Automanager</span>
            <span>작업의 흐름을, 온전히 기억해요.</span>
          </div>
        </main>
        <footer className={`capture-bar ${active ? "is-recording" : ""}`}>
          <div className="capture-status">
            <span
              className={`capture-dot ${active?.status === "recording" ? "live" : ""}`}
            />
            <span>
              {active
                ? active.status === "paused"
                  ? "기록이 일시정지되었어요"
                  : "지금 작업을 기록하고 있어요"
                : "기록할 준비가 되었어요"}
            </span>
            {active && (
              <span className="capture-time">{formatTime(activeDuration)}</span>
            )}
          </div>
          <div className="capture-tools">
            {active ? (
              <>
                <button
                  className="footer-comment"
                  onClick={() => {
                    selectedId.current = active.id;
                    setSelected(active.id);
                    setComment(true);
                  }}
                >
                  <MessageSquare size={16} />
                  주석 추가
                </button>
                <IconButton
                  icon={active.status === "paused" ? Play : Pause}
                  label={
                    active.status === "paused" ? "기록 재개" : "기록 일시정지"
                  }
                  disabled={pending > 0}
                  onClick={() =>
                    void run(() =>
                      active.status === "paused"
                        ? api.resumeSession()
                        : api.pauseSession(),
                    )
                  }
                />
                <Button
                  className="stop-button"
                  disabled={pending > 0}
                  onClick={() =>
                    void run(
                      () => api.stopSession(),
                      "기록을 안전하게 저장했어요.",
                    )
                  }
                >
                  <Square size={12} fill="currentColor" />
                  기록 종료
                </Button>
              </>
            ) : (
              <>
                <span>
                  <Monitor size={15} />
                  {state?.settings.screenEnabled ? "화면 켜짐" : "화면 꺼짐"}
                </span>
                <span>
                  <Mic size={15} />
                  {state?.settings.audioEnabled ? "음성 켜짐" : "음성 꺼짐"}
                </span>
                <span className="local-status">
                  <span />
                  로컬 저장
                </span>
              </>
            )}
          </div>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          {toast}
          <IconButton
            icon={X}
            label="알림 닫기"
            onClick={() => setToast(null)}
          />
        </div>
      )}
      {showStart && state && (
        <StartDialog
          settings={state.settings}
          busy={pending > 0}
          onClose={() => setShowStart(false)}
          onStart={start}
        />
      )}
      {comment && selected && (
        <CommentDialog
          api={api}
          allowRegion={active?.id === selected && active.screen}
          busy={pending > 0}
          onClose={() => setComment(false)}
          onSave={async (text, rect) => {
            const saved = await run(async () => {
              if (rect) await api.addComment(selected, text, rect);
              else await api.addComment(selected, text);
              return true;
            }, "주석을 저장했어요.");
            if (saved) {
              setComment(false);
              await fetchDetail(selected);
            }
          }}
        />
      )}
      {rename && (
        <RenameDialog
          session={rename}
          busy={pending > 0}
          onClose={() => setRename(null)}
          onSave={async (title) => {
            const result = await run(async () => {
              await api.renameSession(rename.id, title);
              return true;
            }, "기록 이름을 변경했어요.");
            if (result) setRename(null);
          }}
        />
      )}
      {deleting && (
        <Dialog
          title="기록을 삭제할까요?"
          description="이 기록의 화면, 음성, 텍스트와 변환 작업이 함께 삭제돼요. 삭제한 기록은 복구할 수 없어요."
          onClose={() => setDeleting(null)}
        >
          <div className="delete-preview">
            <FileText size={20} />
            <strong>{deleting.title}</strong>
          </div>
          <div className="dialog-actions">
            <Button onClick={() => setDeleting(null)}>취소</Button>
            <Button
              tone="danger"
              disabled={pending > 0}
              onClick={() =>
                void run(async () => {
                  await api.deleteSession(deleting.id);
                  return true;
                }, "기록을 삭제했어요.").then((result) => {
                  if (result) {
                    if (selected === deleting.id) navigate("library");
                    setDeleting(null);
                  }
                })
              }
            >
              <Trash2 size={16} />
              기록 삭제
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
function SessionCard({
  session,
  onOpen,
  onRename,
  onDelete,
  onExport,
  compact,
}: {
  session: Session;
  onOpen: (session: Session) => void;
  onRename?: (session: Session) => void;
  onDelete?: (session: Session) => void;
  onExport?: (id: string) => void;
  compact?: boolean;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <div className={`session-card ${compact ? "compact" : ""}`}>
      <button
        className="session-main"
        aria-label={`${session.title} 열기`}
        onClick={() => onOpen(session)}
      >
        <div className="session-symbol">
          <FileText size={compact ? 22 : 27} strokeWidth={1.5} />
          {session.audio && (
            <span>
              <Mic size={11} />
            </span>
          )}
        </div>
        <div className="session-info">
          <strong>{session.title}</strong>
          <span>
            {date(session.startedAt)} <i /> {duration(session.durationMs)}
          </span>
          {!compact && (
            <div className="session-metadata">
              <span>
                <MousePointer2 size={13} />
                {session.stepCount}단계
              </span>
              <span>
                <Mic size={13} />
                {session.audioCount}개 음성
              </span>
            </div>
          )}
        </div>
        {compact ? (
          <ChevronRight size={18} className="muted" />
        ) : (
          <Badge status={session.status} />
        )}
      </button>
      {!compact && (
        <div className="card-bottom">
          <span>
            <Monitor size={14} />
            {session.screen ? "화면 기록" : "작업 텍스트"}
            {session.audio && (
              <>
                <span className="tiny-separator" />
                <Mic size={14} />
                음성 기록
              </>
            )}
          </span>
          <div className="menu-wrapper">
            <IconButton
              icon={MoreHorizontal}
              label={`${session.title} 메뉴`}
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            />
            {menu && (
              <>
                <button
                  className="menu-dismiss"
                  aria-label="메뉴 닫기"
                  onClick={() => setMenu(false)}
                />
                <div className="dropdown-menu">
                  {onRename && (
                    <button
                      onClick={() => {
                        setMenu(false);
                        onRename(session);
                      }}
                    >
                      이름 변경
                    </button>
                  )}
                  {onExport && (
                    <button
                      onClick={() => {
                        setMenu(false);
                        onExport(session.id);
                      }}
                    >
                      내보내기
                    </button>
                  )}
                  {onDelete && (
                    <button
                      className="text-danger"
                      onClick={() => {
                        setMenu(false);
                        onDelete(session);
                      }}
                    >
                      삭제
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Overview({
  state,
  durationMs,
  onStart,
  onOpen,
  onLibrary,
  onSettings,
  onPause,
  onStop,
}: {
  state: AppSnapshot;
  durationMs: number;
  onStart: () => void;
  onOpen: (session: Session) => void;
  onLibrary: () => void;
  onSettings: () => void;
  onPause: () => void;
  onStop: () => void;
}) {
  const total = state.sessions.reduce(
    (sum, session) => sum + session.durationMs,
    0,
  );
  const completedJobs = state.jobs.filter(
    (job) => job.kind === "stt" && job.status === "completed",
  ).length;
  const running = state.jobs.filter(
    (job) => job.status === "running" || job.status === "queued",
  ).length;
  const active = state.activeSession;
  const ready = state.models.filter((model) => model.status === "ready");
  return (
    <>
      <PageTitle
        eyebrow="MY WORKSPACE"
        title="오늘의 작업을 기억해요"
        description="흩어지는 작업과 생각을 하나의 기록으로 모아보세요."
      />
      <section className={`recording-hero ${active ? "active" : ""}`}>
        <div className="hero-copy">
          <div className="hero-kicker">
            <span />
            {active ? "현재 진행 중인 기록" : "당신의 다음 작업을 위한 준비"}
          </div>
          <h2>
            {active ? (
              active.title
            ) : (
              <>
                시작은 가볍게,
                <br />
                기록은 빠짐없이.
              </>
            )}
          </h2>
          <p>
            {active
              ? `${formatTime(durationMs)} · ${active.stepCount}단계 · ${active.audioCount}개 음성 저장`
              : "화면 속 작업, 그 순간의 목소리까지.\n기록에 집중하지 않아도 모든 흐름이 남아요."}
          </p>
          <div className="hero-actions">
            {active ? (
              <>
                <Button tone="primary" onClick={() => onOpen(active)}>
                  <ArrowRight size={17} />
                  기록 열기
                </Button>
                <Button onClick={onPause}>
                  {active.status === "paused" ? (
                    <Play size={16} />
                  ) : (
                    <Pause size={16} />
                  )}
                  {active.status === "paused" ? "재개" : "일시정지"}
                </Button>
                <Button onClick={onStop}>
                  <Square size={12} fill="currentColor" />
                  종료
                </Button>
              </>
            ) : (
              <>
                <Button tone="primary" onClick={onStart}>
                  <Plus size={18} />첫 기록 시작하기
                </Button>
                <span>
                  <ShieldCheck size={14} />내 컴퓨터에만 저장
                </span>
              </>
            )}
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <span className="art-orbit orbit-one" />
          <span className="art-orbit orbit-two" />
          <div className="art-document">
            <div className="art-document-header">
              <BrandMark small />
              <span />
              <i />
            </div>
            <div className="art-lines">
              <span />
              <span />
              <span />
            </div>
            <div className="waveform">
              {[
                12, 24, 16, 37, 50, 29, 19, 43, 65, 43, 29, 52, 71, 46, 29, 42,
                22, 33, 17, 25,
              ].map((height, i) => (
                <i key={i} style={{ height }} />
              ))}
            </div>
            <div className="art-document-footer">
              <span />
              <span />
            </div>
          </div>
          <div className="art-chip">
            <Check size={15} />
            <span>하나의 타임라인</span>
          </div>
          <div className="art-mic">
            <Mic size={24} />
          </div>
        </div>
      </section>
      <section className="stats-grid" aria-label="기록 통계">
        {[
          {
            label: "전체 기록",
            number: String(state.sessions.length),
            suffix: "개",
            icon: Folder,
            detail: "지금까지 쌓인 작업",
          },
          {
            label: "기록한 시간",
            number:
              total >= 3600000
                ? (total / 3600000).toFixed(1)
                : String(Math.floor(total / 60000)),
            suffix: total >= 3600000 ? "시간" : "분",
            icon: Clock3,
            detail: "당신이 집중한 시간",
          },
          {
            label: "저장한 음성",
            number: String(
              state.sessions.reduce(
                (sum, session) => sum + session.audioCount,
                0,
              ),
            ),
            suffix: "개",
            icon: Mic,
            detail: "순간의 생각이 담긴 조각",
          },
          {
            label: "완료한 음성 변환",
            number: String(completedJobs),
            suffix: "개",
            icon: AudioLines,
            detail: running
              ? `${running}개 작업이 대기 또는 진행 중`
              : "읽을 수 있는 목소리",
          },
        ].map((item) => (
          <div className="stat-card" key={item.label}>
            <div>
              <span>{item.label}</span>
              <item.icon size={18} strokeWidth={1.5} />
            </div>
            <strong>
              {item.number}
              <small>{item.suffix}</small>
            </strong>
            <p>{item.detail}</p>
          </div>
        ))}
      </section>
      <div className="overview-columns">
        <section className="panel recent-panel">
          <div className="section-heading">
            <div>
              <h2>
                최근 기록<span>{state.sessions.length}</span>
              </h2>
              <p>가장 최근의 작업을 이어서 살펴보세요.</p>
            </div>
            <button className="text-button" onClick={onLibrary}>
              모두 보기
              <ArrowRight size={15} />
            </button>
          </div>
          {state.sessions.length ? (
            <div className="recent-list">
              {state.sessions.slice(0, 4).map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onOpen={onOpen}
                  compact
                />
              ))}
            </div>
          ) : (
            <Empty
              action={
                <Button onClick={onStart}>
                  <Plus size={16} />
                  기록 시작하기
                </Button>
              }
            />
          )}
        </section>
        <aside className="overview-aside">
          <section className="panel setup-panel">
            <div className="section-heading">
              <h2>나의 기록 환경</h2>
              <Settings2 size={17} className="muted" />
            </div>
            <div className="environment-row">
              <div className="environment-icon">
                <Monitor size={18} />
              </div>
              <div>
                <strong>작업 화면</strong>
                <span>
                  {state.settings.screenEnabled
                    ? "화면과 작업 단계를 함께 기록"
                    : "화면 저장 꺼짐"}
                </span>
              </div>
              <span
                className={`mini-status ${state.settings.screenEnabled ? "ready" : ""}`}
              >
                {state.settings.screenEnabled ? "켜짐" : "꺼짐"}
              </span>
            </div>
            <div className="environment-row">
              <div className="environment-icon">
                <Mic size={18} />
              </div>
              <div>
                <strong>마이크 녹음</strong>
                <span>
                  {state.settings.audioEnabled
                    ? `${state.settings.chunkSeconds}초마다 안전하게 조각 저장`
                    : "음성 녹음 꺼짐"}
                </span>
              </div>
              <span
                className={`mini-status ${state.settings.audioEnabled ? "ready" : ""}`}
              >
                {state.settings.audioEnabled ? "켜짐" : "꺼짐"}
              </span>
            </div>
            <div className="environment-row">
              <div className="environment-icon">
                <Sparkles size={18} />
              </div>
              <div>
                <strong>로컬 음성 모델</strong>
                <span>
                  {ready.length
                    ? `${ready.length}개 모델 사용 가능`
                    : "설치 후 음성 처리를 시작해요"}
                </span>
              </div>
              <span className={`mini-status ${ready.length ? "ready" : ""}`}>
                {ready.length ? "준비됨" : "미설치"}
              </span>
            </div>
            <Button className="full-width" onClick={onSettings}>
              환경 설정
              <ArrowRight size={15} />
            </Button>
          </section>
          <section className="privacy-panel">
            <div className="privacy-symbol">
              <ShieldCheck size={22} />
            </div>
            <h3>당신의 기록은, 당신에게만.</h3>
            <p>
              화면과 음성은 이 컴퓨터에 저장돼요.
              <br />
              모델 설치 후 음성 처리도 로컬에서.
            </p>
            <span>
              PRIVATE BY DEFAULT <span>↗</span>
            </span>
          </section>
        </aside>
      </div>
    </>
  );
}

function Library({
  state,
  api,
  onOpen,
  onStart,
  onRename,
  onDelete,
  onExport,
}: {
  state: AppSnapshot;
  api: DesktopAPI;
  onOpen: (session: Session) => void;
  onStart: () => void;
  onRename: (session: Session) => void;
  onDelete: (session: Session) => void;
  onExport: (id: string) => void;
}) {
  const [search, setSearch] = useState(""),
    [period, setPeriod] = useState("all"),
    [transcription, setTranscription] = useState("all"),
    [app, setApp] = useState("all");
  const [details, setDetails] = useState<Record<string, SessionDetail>>({});
  const [filterError, setFilterError] = useState("");
  useEffect(() => {
    let alive = true;
    Promise.allSettled(
      state.sessions.map((session) => api.getSession(session.id)),
    ).then((results) => {
      if (!alive) return;
      const values: Record<string, SessionDetail> = {};
      results.forEach((result) => {
        if (result.status === "fulfilled")
          values[result.value.session.id] = result.value;
      });
      setDetails(values);
      setFilterError(
        results.some((result) => result.status === "rejected")
          ? "일부 기록의 앱 정보를 불러오지 못했어요."
          : "",
      );
    });
    return () => {
      alive = false;
    };
  }, [api, state.sessions]);
  const apps = [
    ...new Set(
      Object.values(details).flatMap((detail) =>
        detail.steps.map((step) => step.appName).filter(Boolean),
      ),
    ),
  ].sort();
  const sessions = state.sessions.filter((session) => {
    const jobs = state.jobs.filter(
      (job) => job.sessionId === session.id && job.kind === "stt",
    );
    const after =
      period === "today"
        ? new Date().setHours(0, 0, 0, 0)
        : period === "week"
          ? Date.now() - 7 * 86400000
          : period === "month"
            ? Date.now() - 30 * 86400000
            : 0;
    return (
      session.title.toLowerCase().includes(search.toLowerCase()) &&
      session.startedAt >= after &&
      (app === "all" ||
        details[session.id]?.steps.some((step) => step.appName === app)) &&
      (transcription === "all" ||
        (transcription === "completed" &&
          jobs.some((job) => job.status === "completed")) ||
        (transcription === "pending" &&
          !jobs.some((job) => job.status === "completed")) ||
        (transcription === "failed" &&
          jobs.some((job) => job.status === "failed")))
    );
  });
  return (
    <>
      <PageTitle
        eyebrow="RECORD LIBRARY"
        title="기록 라이브러리"
        description="작업의 과정과 순간의 생각을 다시 만나는 곳."
      />
      <div className="library-toolbar">
        <label className="search-field">
          <Search size={18} />
          <input
            aria-label="기록 검색"
            placeholder="기록 이름으로 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>⌕</kbd>
        </label>
        <select
          aria-label="기록 날짜 필터"
          value={period}
          onChange={(event) => setPeriod(event.target.value)}
        >
          <option value="all">모든 날짜</option>
          <option value="today">오늘</option>
          <option value="week">최근 7일</option>
          <option value="month">최근 30일</option>
        </select>
        <select
          aria-label="앱 필터"
          value={app}
          onChange={(event) => setApp(event.target.value)}
        >
          <option value="all">모든 앱</option>
          {apps.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select
          aria-label="음성 변환 필터"
          value={transcription}
          onChange={(event) => setTranscription(event.target.value)}
        >
          <option value="all">모든 변환 상태</option>
          <option value="completed">변환 완료</option>
          <option value="pending">미변환</option>
          <option value="failed">변환 실패</option>
        </select>
      </div>
      {filterError && (
        <p role="alert" className="inline-error">
          {filterError}
        </p>
      )}
      <div className="library-count">
        전체 기록 <strong>{sessions.length}</strong>
        <span>최근 기록 순</span>
      </div>
      {sessions.length ? (
        <div className="session-grid">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              {...{ session, onOpen, onRename, onDelete, onExport }}
            />
          ))}
        </div>
      ) : (
        <section className="panel library-empty">
          <Empty
            title={state.sessions.length ? "검색 결과가 없어요" : undefined}
            description={
              state.sessions.length
                ? "검색어나 필터를 바꿔서 다시 찾아보세요."
                : undefined
            }
            action={
              state.sessions.length ? (
                <Button
                  onClick={() => {
                    setSearch("");
                    setApp("all");
                    setPeriod("all");
                    setTranscription("all");
                  }}
                >
                  필터 초기화
                </Button>
              ) : (
                <Button tone="primary" onClick={onStart}>
                  <Plus size={16} />첫 기록 시작하기
                </Button>
              )
            }
          />
        </section>
      )}
    </>
  );
}

function SessionReview({
  detail,
  api,
  active,
  onBack,
  onRename,
  onDelete,
  onComment,
  onExport,
  onTranscribe,
}: {
  detail: SessionDetail | null;
  api: DesktopAPI;
  active: boolean;
  onBack: () => void;
  onRename: (session: Session) => void;
  onDelete: (session: Session) => void;
  onComment: () => void;
  onExport: () => void;
  onTranscribe: () => void;
}) {
  const [index, setIndex] = useState(0),
    [tab, setTab] = useState("screen"),
    [playing, setPlaying] = useState(false),
    [zoom, setZoom] = useState(false);
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [detail?.session.id]);
  useEffect(() => {
    if (!playing || !detail?.steps.length) return;
    const interval = window.setInterval(
      () =>
        setIndex((value) => {
          if (value >= detail.steps.length - 1) {
            setPlaying(false);
            return value;
          }
          return value + 1;
        }),
      3000,
    );
    return () => window.clearInterval(interval);
  }, [playing, detail?.steps.length]);
  if (!detail)
    return (
      <div className="loading">
        <LoaderCircle className="spin" size={24} />
        <p>기록을 불러오는 중이에요</p>
      </div>
    );
  const step =
    detail.steps[Math.min(index, Math.max(0, detail.steps.length - 1))];
  const image = step?.screenshot
    ? api.assetUrl(detail.session.id, step.screenshot)
    : null;
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} />
        기록 라이브러리
      </button>
      <div className="review-header">
        <div>
          <h1>
            {detail.session.title}
            <IconButton
              icon={MoreHorizontal}
              label="기록 이름 변경"
              onClick={() => onRename(detail.session)}
            />
          </h1>
          <div className="review-meta">
            <Badge status={detail.session.status} />
            <span>{date(detail.session.startedAt)}</span>
            <span>
              <Clock3 size={14} />
              {duration(detail.session.durationMs)}
            </span>
            <span>
              <MousePointer2 size={14} />
              {detail.session.stepCount}단계
            </span>
          </div>
        </div>
        <div className="review-actions">
          <Button onClick={onComment}>
            <MessageSquare size={16} />
            주석 추가
          </Button>
          <Button onClick={onExport}>
            <Download size={16} />
            내보내기
          </Button>
          <IconButton
            icon={Trash2}
            label="기록 삭제"
            onClick={() => onDelete(detail.session)}
          />
        </div>
      </div>
      <div className="review-layout">
        <section className="panel timeline-panel">
          <div className="timeline-header">
            <h2>
              작업 타임라인<span>{detail.steps.length}</span>
            </h2>
            <IconButton
              icon={playing ? Pause : Play}
              label={playing ? "단계 재생 일시정지" : "단계 자동 재생"}
              disabled={!detail.steps.length}
              onClick={() => setPlaying(!playing)}
            />
          </div>
          {detail.steps.length ? (
            <div className="timeline-list">
              {detail.steps.map((item, i) => (
                <button
                  key={item.id}
                  className={`timeline-item ${i === index ? "chosen" : ""}`}
                  onClick={() => {
                    setIndex(i);
                    setTab("screen");
                  }}
                >
                  <span
                    className={`step-marker ${item.kind === "comment" ? "comment" : ""}`}
                  >
                    {item.kind === "comment" ? (
                      <MessageSquare size={13} />
                    ) : (
                      item.sequence
                    )}
                  </span>
                  <div>
                    <span className="step-time">
                      {formatTime(item.offsetMs)}
                      <span>{item.appName || "작업"}</span>
                    </span>
                    <strong>{item.description}</strong>
                    {item.warning && (
                      <small className="inline-error">{item.warning}</small>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Empty
              icon={MousePointer2}
              title={
                active
                  ? "첫 단계를 기다리고 있어요"
                  : "저장된 작업 단계가 없어요"
              }
              description={
                active
                  ? "작업을 시작하면 타임라인에 차례로 표시돼요."
                  : "음성 기록은 오른쪽 음성 탭에서 확인할 수 있어요."
              }
            />
          )}
        </section>
        <section className="panel step-panel">
          <div
            className="review-tabs"
            role="tablist"
            aria-label="기록 상세 보기"
          >
            <button
              role="tab"
              aria-selected={tab === "screen"}
              onClick={() => setTab("screen")}
            >
              <Monitor size={16} />
              화면 및 주석
            </button>
            <button
              role="tab"
              aria-label="음성 및 텍스트"
              aria-selected={tab === "audio"}
              onClick={() => setTab("audio")}
            >
              <AudioLines size={16} />
              음성 및 텍스트<span>{detail.chunks.length}</span>
            </button>
          </div>
          {tab === "screen" ? (
            <div className="step-detail">
              {step ? (
                <>
                  <div className="step-detail-heading">
                    <div>
                      <span className="eyebrow">
                        STEP {String(step.sequence).padStart(2, "0")}
                      </span>
                      <h2>{step.description}</h2>
                      <p>
                        {step.appName}{" "}
                        {step.windowTitle && <>· {step.windowTitle}</>}
                      </p>
                    </div>
                    <span className="mono-time">
                      {formatTime(step.offsetMs)}
                    </span>
                  </div>
                  <div className="screenshot-stage">
                    {image ? (
                      <button
                        className="screenshot-button"
                        onClick={() => setZoom(true)}
                        aria-label="스크린샷 크게 보기"
                      >
                        <Screenshot image={image} step={step} />
                        <span>클릭해서 크게 보기</span>
                      </button>
                    ) : (
                      <div className="no-screenshot">
                        <Monitor size={36} strokeWidth={1.2} />
                        <h3>이 단계의 화면이 없어요</h3>
                        <p>
                          {step.warning ||
                            "화면 기록이 꺼져 있거나 보관 한도를 지난 단계예요."}
                        </p>
                      </div>
                    )}
                  </div>
                  {step.kind === "comment" && (
                    <div className="comment-card">
                      <MessageSquare size={17} />
                      <p>{step.description}</p>
                    </div>
                  )}
                  <div className="step-navigation">
                    <Button
                      disabled={index === 0}
                      onClick={() => setIndex(index - 1)}
                    >
                      <ChevronLeft size={15} />
                      이전 단계
                    </Button>
                    <span>
                      {index + 1} / {detail.steps.length}
                    </span>
                    <Button
                      disabled={index >= detail.steps.length - 1}
                      onClick={() => setIndex(index + 1)}
                    >
                      다음 단계
                      <ChevronRight size={15} />
                    </Button>
                  </div>
                </>
              ) : (
                <Empty
                  icon={Monitor}
                  title="작업 화면을 기다리고 있어요"
                  description="타임라인에 저장된 단계를 선택하면 화면을 볼 수 있어요."
                />
              )}
            </div>
          ) : (
            <div className="audio-detail">
              <div className="audio-detail-heading">
                <div>
                  <h2>목소리와 함께 되짚어보기</h2>
                  <p>
                    {detail.chunks.length}개 음성 · 조각별 원본과 변환 텍스트
                  </p>
                </div>
                <Button onClick={onTranscribe} disabled={!detail.chunks.length}>
                  <Sparkles size={15} />
                  음성 변환
                </Button>
              </div>
              {detail.chunks.length ? (
                detail.chunks.map((chunk) => (
                  <div className="audio-chunk" key={chunk.id}>
                    <div className="audio-chunk-heading">
                      <span>
                        <Mic size={15} />
                        음성 {String(chunk.sequence).padStart(2, "0")}
                      </span>
                      <span>
                        {formatTime(chunk.offsetMs)} ·{" "}
                        {duration(chunk.durationMs)}
                      </span>
                      <Badge status={chunk.status} />
                    </div>
                    <audio
                      controls
                      preload="none"
                      src={api.assetUrl(detail.session.id, chunk.file)}
                      aria-label={`음성 ${chunk.sequence} 재생`}
                    />
                    <p
                      className={
                        chunk.transcript ? "transcript" : "transcript empty"
                      }
                    >
                      {chunk.transcript ||
                        (chunk.status === "failed"
                          ? "변환에 실패했어요. 음성 변환 화면에서 다시 시도해 주세요."
                          : "아직 변환된 텍스트가 없어요.")}
                    </p>
                  </div>
                ))
              ) : (
                <Empty
                  icon={MicOff}
                  title="저장된 음성이 없어요"
                  description="음성 녹음을 켜고 기록하면 이곳에서 들을 수 있어요."
                />
              )}
            </div>
          )}
        </section>
      </div>
      {zoom && image && (
        <Dialog
          title={`단계 ${step.sequence} · ${step.description}`}
          onClose={() => setZoom(false)}
          wide
        >
          <div className="zoom-image">
            <Screenshot image={image} step={step} />
          </div>
        </Dialog>
      )}
    </>
  );
}
function Screenshot({ image, step }: { image: string; step?: Step }) {
  return (
    <div className="screenshot-image">
      <img
        src={image}
        alt={step ? `${step.description} 당시의 작업 화면` : "기록한 작업 화면"}
      />
    </div>
  );
}

type Run = <T>(
  work: () => Promise<T>,
  success?: string,
) => Promise<T | undefined>;
function JobCard({
  job,
  api,
  run,
  session,
}: {
  job: Job;
  api: DesktopAPI;
  run: Run;
  session?: Session;
}) {
  return (
    <div className="job-card">
      <div className="job-icon">
        <AudioLines size={21} />
      </div>
      <div className="job-content">
        <div>
          <strong>
            {session?.title || (job.kind === "tts" ? "음성 생성" : "음성 변환")}
          </strong>
          <Badge status={job.status} />
        </div>
        <p>
          {job.modelId} · {date(job.createdAt)}
          {job.chunkId && " · 음성 조각"}
        </p>
        {job.status === "running" && (
          <div
            className="progress-track"
            role="progressbar"
            aria-label="변환 진행률"
            aria-valuenow={Math.round(job.progress)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${job.progress}%` }} />
          </div>
        )}
        {job.error && <p className="inline-error">{job.error}</p>}
      </div>
      <div className="job-actions">
        {(job.status === "queued" || job.status === "running") && (
          <Button
            onClick={() =>
              void run(
                () => api.jobAction(job.id, "cancel"),
                "작업을 취소했어요.",
              )
            }
          >
            <X size={14} />
            취소
          </Button>
        )}
        {(job.status === "failed" || job.status === "canceled") && (
          <Button
            onClick={() =>
              void run(
                () => api.jobAction(job.id, "retry"),
                "작업을 다시 시작했어요.",
              )
            }
          >
            <RefreshCw size={14} />
            재시도
          </Button>
        )}
      </div>
    </div>
  );
}
function Transcription({
  state,
  api,
  run,
  onOpen,
  onSettings,
}: {
  state: AppSnapshot;
  api: DesktopAPI;
  run: Run;
  onOpen: (session: Session) => void;
  onSettings: () => void;
}) {
  const [filter, setFilter] = useState("all"),
    [sessionId, setSessionId] = useState("");
  const jobs = state.jobs.filter(
    (job) =>
      job.kind === "stt" &&
      (filter === "all" || filter === "pending"
        ? filter === "all" ||
          job.status === "queued" ||
          job.status === "running"
        : job.status === filter),
  );
  const whisper = state.models.find(
    (model) => model.id === state.settings.whisperModel,
  );
  return (
    <>
      <PageTitle
        eyebrow="TRANSCRIPTION"
        title="목소리를 텍스트로"
        description="기록은 계속하고, 변환은 백그라운드에 맡기세요."
      />
      <section className="panel transcription-controls">
        <div className="transcription-model">
          <div className="blue-icon">
            <Sparkles size={23} />
          </div>
          <div>
            <strong>
              {whisper?.name || "Whisper"}
              <span
                className={`mini-status ${whisper?.status === "ready" ? "ready" : ""}`}
              >
                {whisper?.status === "ready" ? "모델 준비됨" : "모델 미설치"}
              </span>
            </strong>
            <p>한국어 · 로컬 처리 · 한 번에 하나의 음성 조각</p>
          </div>
          <Button onClick={onSettings}>
            모델 관리
            <ArrowRight size={14} />
          </Button>
        </div>
        <div className="manual-transcription">
          <label htmlFor="transcribe-session">기록 선택</label>
          <select
            id="transcribe-session"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
          >
            <option value="">변환할 기록을 선택해 주세요</option>
            {state.sessions
              .filter((session) => session.audioCount > 0)
              .map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
          </select>
          <Button
            tone="primary"
            disabled={!sessionId}
            onClick={() =>
              void run(
                () => api.transcribe(sessionId),
                "음성 변환 대기열에 추가했어요.",
              )
            }
          >
            <Sparkles size={16} />
            변환 시작
          </Button>
        </div>
      </section>
      <div className="queue-heading">
        <div className="filter-tabs" aria-label="작업 상태 필터">
          {[
            { value: "all", label: "전체" },
            { value: "pending", label: "진행 및 대기" },
            { value: "completed", label: "완료" },
            { value: "failed", label: "실패" },
          ].map((item) => (
            <button
              key={item.value}
              className={filter === item.value ? "active" : ""}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span>{jobs.length}개 작업</span>
      </div>
      <section className="panel queue-list">
        {jobs.length ? (
          jobs.map((job) => (
            <div key={job.id}>
              <JobCard
                {...{ job, api, run }}
                session={state.sessions.find(
                  (session) => session.id === job.sessionId,
                )}
              />
              {job.status === "completed" &&
                state.sessions.find(
                  (session) => session.id === job.sessionId,
                ) && (
                  <button
                    className="job-view-link"
                    onClick={() =>
                      onOpen(
                        state.sessions.find(
                          (session) => session.id === job.sessionId,
                        )!,
                      )
                    }
                  >
                    원래 기록에서 텍스트 보기
                    <ArrowRight size={14} />
                  </button>
                )}
            </div>
          ))
        ) : (
          <Empty
            icon={AudioLines}
            title="대기열이 비어 있어요"
            description="음성이 있는 기록을 선택하면 텍스트 변환을 시작할 수 있어요."
          />
        )}
      </section>
      <div className="info-note">
        <ShieldCheck size={16} />
        음성은 외부 서버로 보내지지 않아요. 변환 속도는 컴퓨터 성능과 모델에
        따라 달라져요.
      </div>
    </>
  );
}

function VoiceStudio({
  state,
  api,
  run,
  onSettings,
}: {
  state: AppSnapshot;
  api: DesktopAPI;
  run: Run;
  onSettings: () => void;
}) {
  const [text, setText] = useState(""),
    [voice, setVoice] = useState("melo-ko"),
    [speed, setSpeed] = useState(1),
    [created, setCreated] = useState<Job | null>(null),
    [busy, setBusy] = useState(false);
  const model = state.models.find((model) =>
    voice === "melo-ko" ? /melo/i.test(model.id) : /kokoro/i.test(model.id),
  );
  const result = created
    ? state.jobs.find((job) => job.id === created.id) || created
    : null;
  const jobs = state.jobs.filter((job) => job.kind === "tts");
  const create = async () => {
    if (!text.trim()) return;
    setBusy(true);
    const job = await run(() =>
      api.synthesize({ text: text.trim(), voiceId: voice, speed }),
    );
    if (job) setCreated(job);
    setBusy(false);
  };
  const resultUrl = result?.output
    ? api.assetUrl(result.sessionId || "tts", result.output)
    : null;
  return (
    <>
      <PageTitle
        eyebrow="VOICE STUDIO"
        title="생각에 목소리를 더해요"
        description="원하는 문장을, 나만의 속도로 자연스럽게 읽어보세요."
      />
      <div className="voice-layout">
        <section className="panel voice-editor">
          <div className="section-heading">
            <h2>
              <FileText size={18} />
              읽을 텍스트
            </h2>
            <span>{text.length.toLocaleString()} / 10,000</span>
          </div>
          <textarea
            aria-label="읽을 텍스트"
            placeholder={
              "어떤 이야기를 들려드릴까요?\n\n메모, 발표 원고, 떠오른 생각을 입력해 보세요."
            }
            value={text}
            maxLength={10000}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="voice-editor-bottom">
            <span>
              <ShieldCheck size={14} />이 컴퓨터에서 음성을 만들어요
            </span>
            <Button
              tone="primary"
              disabled={!text.trim() || busy}
              onClick={create}
            >
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Sparkles size={17} />
              )}
              음성 생성
            </Button>
          </div>
        </section>
        <aside className="panel voice-options">
          <h2>목소리 설정</h2>
          <label htmlFor="voice-language">언어</label>
          <select
            id="voice-language"
            value={voice === "melo-ko" ? "ko" : "en"}
            onChange={(event) =>
              setVoice(event.target.value === "ko" ? "melo-ko" : "af_heart")
            }
          >
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
          <label htmlFor="voice-select">음성 및 엔진</label>
          <select
            id="voice-select"
            value={voice}
            onChange={(event) => setVoice(event.target.value)}
          >
            <option value="melo-ko">Melo · 한국어</option>
            <option value="af_heart">Kokoro · Heart (English)</option>
          </select>
          <div className="model-state">
            <span
              className={`status-dot ${model?.status === "ready" ? "green" : ""}`}
            />
            {model?.status === "ready"
              ? "로컬 모델 사용 가능"
              : "모델 설치가 필요해요"}
            {model?.status !== "ready" && (
              <button onClick={onSettings}>
                설치하기
                <ArrowRight size={12} />
              </button>
            )}
          </div>
          <div className="speed-heading">
            <label htmlFor="voice-speed">읽기 속도</label>
            <strong>{speed.toFixed(1)}×</strong>
          </div>
          <input
            id="voice-speed"
            type="range"
            min="0.5"
            max="2"
            step="0.1"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
          <div className="range-labels">
            <span>느리게</span>
            <span>빠르게</span>
          </div>
          <div className="voice-guidance">
            <Headphones size={18} />
            <p>
              녹음 중에는 헤드폰을 사용하면 재생 음성이 마이크에 들어가지
              않아요.
            </p>
          </div>
        </aside>
      </div>
      <section className="panel generated-voice">
        <div className="section-heading">
          <h2>생성한 음성</h2>
          <span>WAV · 로컬 파일</span>
        </div>
        {result ? (
          <div className="voice-result">
            <div className="result-heading">
              <div className="blue-icon">
                <Volume2 size={22} />
              </div>
              <div>
                <strong>{text.slice(0, 50) || "생성한 음성"}</strong>
                <span>{result.modelId}</span>
              </div>
              <Badge status={result.status} />
            </div>
            {result.error && <p className="inline-error">{result.error}</p>}
            {resultUrl ? (
              <div className="result-player">
                <audio controls src={resultUrl} aria-label="생성한 음성 재생" />
                <a
                  className="button secondary"
                  href={resultUrl}
                  download={`automanager-voice-${result.id}.wav`}
                >
                  <ArrowDownToLine size={16} />
                  WAV 저장
                </a>
              </div>
            ) : (
              <p className="result-waiting">
                {result.status === "completed"
                  ? "완료된 음성 파일이 연결되지 않았어요."
                  : result.status === "failed"
                    ? "생성에 실패했어요. 모델과 엔진 설정을 확인해 주세요."
                    : "음성을 만들고 있어요. 다른 작업을 해도 괜찮아요."}
              </p>
            )}
          </div>
        ) : (
          <Empty
            icon={Waves}
            title="당신의 첫 목소리를 기다려요"
            description="텍스트를 입력하고 음성 생성을 누르면 여기에서 듣고 저장할 수 있어요."
          />
        )}
      </section>
      {jobs.length > 0 && (
        <section className="panel voice-jobs">
          <div className="section-heading">
            <h2>생성 작업</h2>
          </div>
          {jobs.map((job) => (
            <div key={job.id}>
              <JobCard {...{ job, api, run }} />
              {job.output && job.status === "completed" && (
                <div className="result-player">
                  <audio
                    controls
                    preload="none"
                    src={api.assetUrl(job.sessionId || "tts", job.output)}
                    aria-label={`${job.text.slice(0, 30)} 음성 재생`}
                  />
                  <a
                    className="button secondary"
                    href={api.assetUrl(job.sessionId || "tts", job.output)}
                    download={`voice-${job.id}.wav`}
                  >
                    <Download size={14} />
                    저장
                  </a>
                </div>
              )}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function Schedules({
  state,
  api,
  run,
}: {
  state: AppSnapshot;
  api: DesktopAPI;
  run: Run;
}) {
  const [editing, setEditing] = useState<Schedule | "new" | null>(null),
    [deleting, setDeleting] = useState<Schedule | null>(null);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return (
    <>
      <PageTitle
        eyebrow="SCHEDULES"
        title="기록할 시간을 정해두세요"
        description="정해진 시간에 시작하고, 필요한 만큼만 기록해요."
        action={
          <Button tone="primary" onClick={() => setEditing("new")}>
            <Plus size={17} />
            예약 추가
          </Button>
        }
      />
      <div className="info-note schedule-note">
        <CalendarClock size={20} />
        <div>
          <strong>앱이 실행 중일 때 예약을 시작해요.</strong>
          <p>
            트레이에 숨겨두어도 괜찮아요. 놓친 예약은 갑자기 시작하지 않아요.
          </p>
        </div>
      </div>
      {state.schedules.length ? (
        <div className="schedule-list">
          {state.schedules.map((schedule) => (
            <section className="panel schedule-card" key={schedule.id}>
              <div className="schedule-symbol">
                <CalendarClock size={24} />
              </div>
              <div className="schedule-info">
                <h2>{schedule.title}</h2>
                <p>
                  <strong>{schedule.startTime}</strong>
                  <span>{schedule.durationMinutes}분 기록</span>
                  <span>
                    {schedule.days.length === 7
                      ? "매일"
                      : schedule.days.length
                        ? schedule.days.map((day) => days[day]).join(" · ")
                        : "한 번"}
                  </span>
                </p>
                <small>
                  {schedule.enabled
                    ? `다음 기록 · ${date(schedule.nextRun)}`
                    : "이 예약은 꺼져 있어요"}
                </small>
              </div>
              <Toggle
                label={`${schedule.title} 예약 사용`}
                checked={schedule.enabled}
                onChange={(enabled) =>
                  void run(() =>
                    api.saveSchedule({
                      id: schedule.id,
                      title: schedule.title,
                      enabled,
                      startTime: schedule.startTime,
                      durationMinutes: schedule.durationMinutes,
                      days: schedule.days,
                      nextRun: schedule.nextRun,
                    }),
                  )
                }
              />
              <Button onClick={() => setEditing(schedule)}>수정</Button>
              <IconButton
                icon={Trash2}
                label={`${schedule.title} 예약 삭제`}
                onClick={() => setDeleting(schedule)}
              />
            </section>
          ))}
        </div>
      ) : (
        <section className="panel schedules-empty">
          <Empty
            icon={CalendarClock}
            title="아직 예약된 기록이 없어요"
            description="회의, 공부, 매일의 회고. 기억하고 싶은 시간에 기록을 예약하세요."
            action={
              <Button onClick={() => setEditing("new")}>
                <Plus size={16} />첫 예약 만들기
              </Button>
            }
          />
        </section>
      )}
      {editing && (
        <ScheduleDialog
          schedule={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={(value) =>
            run(async () => {
              await api.saveSchedule(value);
              setEditing(null);
            }, "예약을 저장했어요.")
          }
        />
      )}
      {deleting && (
        <Dialog
          title="예약을 삭제할까요?"
          description={deleting.title}
          onClose={() => setDeleting(null)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setDeleting(null)}>취소</Button>
            <Button
              tone="danger"
              onClick={() =>
                void run(async () => {
                  await api.deleteSchedule(deleting.id);
                  setDeleting(null);
                }, "예약을 삭제했어요.")
              }
            >
              예약 삭제
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function SettingsView({
  state,
  api,
  run,
}: {
  state: AppSnapshot;
  api: DesktopAPI;
  run: Run;
}) {
  const [displays, setDisplays] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [micsLoaded, setMicsLoaded] = useState(false);
  const [micTesting, setMicTesting] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [level, setLevel] = useState(0);
  const [deviceError, setDeviceError] = useState("");
  const [micWarning, setMicWarning] = useState("");
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const mounted = useRef(true);
  const microphoneRequest = useRef(0);
  const deviceListRequest = useRef(0);
  const stopMic = useCallback(() => {
    microphoneRequest.current++;
    cancelAnimationFrame(frame.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close();
    context.current = null;
    setMicTesting(false);
    setMicPending(false);
    setLevel(0);
  }, []);
  const refreshMicrophones = useCallback(async () => {
    const request = ++deviceListRequest.current;
    const devices = await navigator.mediaDevices?.enumerateDevices();
    if (mounted.current && request === deviceListRequest.current) {
      setMics((devices || []).filter((device) => device.kind === "audioinput"));
      setMicsLoaded(true);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    api
      .listDisplays()
      .then((value) => {
        if (mounted.current) setDisplays(value);
      })
      .catch((error) => {
        if (mounted.current) setDeviceError(errorText(error));
      });
    const refresh = () => {
      void refreshMicrophones().catch((error) => {
        if (mounted.current) setDeviceError(errorText(error));
      });
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      mounted.current = false;
      deviceListRequest.current++;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      stopMic();
    };
  }, [api, stopMic, refreshMicrophones]);
  const testMic = async () => {
    if (micTesting) {
      stopMic();
      return;
    }
    const request = ++microphoneRequest.current;
    setMicPending(true);
    setMicWarning("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "이 환경에서 마이크에 접근할 수 없습니다. 데스크톱 앱의 권한 설정을 확인해 주세요.",
        );
      }
      const result = await requestMicrophone(
        navigator.mediaDevices,
        state.settings.micDeviceId,
      );
      if (!mounted.current || request !== microphoneRequest.current) {
        result.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = result.stream;
      if (result.usedDefault) await api.updateSettings({ micDeviceId: "" });
      if (!mounted.current || request !== microphoneRequest.current) return;
      setMicWarning(result.warning || "");
      await refreshMicrophones();
      if (!mounted.current || request !== microphoneRequest.current) return;
      const audio = new AudioContext();
      context.current = audio;
      await audio.resume();
      if (!mounted.current || request !== microphoneRequest.current) return;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 256;
      audio.createMediaStreamSource(result.stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      setDeviceError("");
      setMicTesting(true);
      const updateLevel = () => {
        if (!mounted.current || request !== microphoneRequest.current) return;
        analyser.getByteTimeDomainData(data);
        setLevel(
          Math.min(
            1,
            Math.sqrt(
              data.reduce(
                (sum, sample) => sum + ((sample - 128) / 128) ** 2,
                0,
              ) / data.length,
            ) * 5,
          ),
        );
        frame.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();
    } catch (error) {
      if (mounted.current && request === microphoneRequest.current) {
        stopMic();
        setDeviceError(errorText(error));
      }
    } finally {
      if (mounted.current && request === microphoneRequest.current)
        setMicPending(false);
    }
  };
  const settings = state.settings;
  const update = (patch: Partial<Settings>) =>
    void run(() => api.updateSettings(patch));
  return (
    <>
      <PageTitle
        eyebrow="PREFERENCES"
        title="나에게 맞는 기록 환경"
        description="기록 방식부터 로컬 음성 모델까지, 필요한 만큼 설정해요."
      />
      <div className="settings-layout">
        <div className="settings-main">
          <SettingsSection
            icon={Mic}
            title="음성 녹음"
            description="목소리를 놓치지 않고, 독립적인 WAV 조각으로 저장해요."
          >
            <Toggle
              label="마이크 녹음"
              checked={settings.audioEnabled}
              onChange={(value) => update({ audioEnabled: value })}
            />
            <div className="settings-form-row">
              <label htmlFor="mic-device">입력 장치</label>
              <select
                id="mic-device"
                disabled={micPending}
                value={settings.micDeviceId}
                onChange={(event) => {
                  stopMic();
                  setDeviceError("");
                  setMicWarning("");
                  update({ micDeviceId: event.target.value });
                }}
              >
                <option value="">시스템 기본 마이크</option>
                {settings.micDeviceId &&
                  !mics.some(
                    (mic) => mic.deviceId === settings.micDeviceId,
                  ) && (
                    <option value={settings.micDeviceId}>
                      {micsLoaded
                        ? "저장된 마이크 (연결되지 않음)"
                        : "저장된 마이크 (확인 중)"}
                    </option>
                  )}
                {mics
                  .filter(
                    (mic) =>
                      mic.deviceId &&
                      (mic.deviceId !== "default" ||
                        settings.micDeviceId === "default"),
                  )
                  .map((mic, i) => (
                    <option key={mic.deviceId} value={mic.deviceId}>
                      {mic.label || `마이크 ${i + 1}`}
                    </option>
                  ))}
              </select>
            </div>
            <div className="mic-preview">
              <div
                className="level-meter"
                role="meter"
                aria-label="마이크 입력 레벨"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(level * 100)}
              >
                {Array.from({ length: 28 }, (_, index) => (
                  <i key={index} className={index / 28 < level ? "lit" : ""} />
                ))}
              </div>
              <Button disabled={micPending} onClick={() => void testMic()}>
                {micTesting ? <Square size={12} /> : <Mic size={14} />}
                {micPending
                  ? "마이크 연결 중"
                  : micTesting
                    ? "확인 종료"
                    : "마이크 확인"}
              </Button>
            </div>
            {deviceError && (
              <p className="inline-error" role="alert">
                {deviceError}
              </p>
            )}
            {micWarning && (
              <p className="info-note" role="status">
                {micWarning}
              </p>
            )}
            <div className="settings-form-row">
              <label htmlFor="chunk-seconds">
                녹음 조각 길이<span>녹음을 일정한 길이의 파일로 나눠요</span>
              </label>
              <select
                id="chunk-seconds"
                value={settings.chunkSeconds}
                onChange={(event) =>
                  update({
                    chunkSeconds: Number(
                      event.target.value,
                    ) as Settings["chunkSeconds"],
                  })
                }
              >
                {[15, 30, 60, 120].map((value) => (
                  <option key={value} value={value}>
                    {value}초{value === 30 ? " · 기본값" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Toggle
              label="음성을 자동으로 텍스트 변환"
              description="완성된 음성 조각을 변환 대기열에 추가해요"
              checked={settings.autoTranscribe}
              onChange={(value) => update({ autoTranscribe: value })}
            />
          </SettingsSection>
          <SettingsSection
            icon={Monitor}
            title="작업 및 화면"
            description="화면 한도와 별개로 모든 작업 단계의 텍스트를 보관해요."
          >
            <Toggle
              label="화면 기록"
              checked={settings.screenEnabled}
              onChange={(value) => update({ screenEnabled: value })}
            />
            <div className="settings-form-row">
              <label htmlFor="display">기록할 모니터</label>
              <select
                id="display"
                value={settings.monitorId}
                onChange={(event) => update({ monitorId: event.target.value })}
              >
                <option value="">기본 디스플레이</option>
                {displays.map((display) => (
                  <option value={display.id} key={display.id}>
                    {display.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="settings-form-row">
              <label htmlFor="screenshot-limit">
                화면 보관 한도<span>마지막 N장을 유지해요</span>
              </label>
              <input
                type="number"
                id="screenshot-limit"
                min="1"
                max="10000"
                value={settings.screenshotLimit}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (value >= 1 && value <= 10000)
                    update({ screenshotLimit: value });
                }}
              />
            </div>
          </SettingsSection>
          <SettingsSection
            icon={Folder}
            title="저장 및 백그라운드"
            description="기록은 선택한 로컬 저장 공간에 보관돼요."
          >
            <div className="storage-path">
              <FolderOpen size={19} />
              <span title={state.dataDirectory}>{state.dataDirectory}</span>
              <Button onClick={() => void run(() => api.revealData())}>
                폴더 열기
              </Button>
            </div>
            <div className="settings-form-row">
              <label htmlFor="storage-limit">저장 용량 한도</label>
              <div className="number-with-unit">
                <input
                  id="storage-limit"
                  type="number"
                  min="1"
                  max="1000"
                  value={settings.storageLimitGiB}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (value >= 1 && value <= 1000)
                      update({ storageLimitGiB: value });
                  }}
                />
                <span>GiB</span>
              </div>
            </div>
            <Toggle
              label="로그인할 때 앱 시작"
              description="앱을 시작해도 자동으로 녹음하지 않아요"
              checked={settings.launchOnLogin}
              onChange={(value) => update({ launchOnLogin: value })}
            />
            <Toggle
              label="기록 중 잠자기 방지"
              description="절전 상태에서는 기록이 계속되지 않아요"
              checked={settings.preventSleep}
              onChange={(value) => update({ preventSleep: value })}
            />
          </SettingsSection>
          <SettingsSection
            icon={Sparkles}
            title="로컬 음성 엔진과 모델"
            description="모델 설치에는 인터넷이 필요하며, 설치 후에는 로컬에서 처리해요."
          >
            <div className="settings-form-row">
              <label htmlFor="whisper-model">음성 인식 모델</label>
              <select
                id="whisper-model"
                value={settings.whisperModel}
                onChange={(event) =>
                  update({ whisperModel: event.target.value })
                }
              >
                {state.models
                  .filter((model) => model.kind === "stt")
                  .map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="settings-form-row">
              <label htmlFor="recognition-language">음성 인식 언어</label>
              <select
                id="recognition-language"
                value={settings.language}
                onChange={(event) => update({ language: event.target.value })}
              >
                <option value="ko">한국어</option>
                <option value="en">English</option>
                <option value="auto">자동 감지</option>
              </select>
            </div>
            <div className="model-list">
              {state.models.map((model) => (
                <ModelCard key={model.id} {...{ model, api, run }} />
              ))}
            </div>
          </SettingsSection>
        </div>
        <aside className="settings-aside">
          <section className="panel capability-panel">
            <div className="section-heading">
              <h2>이 기기의 지원 상태</h2>
              <Monitor size={17} />
            </div>
            <p>운영체제와 권한에 따라 사용 가능한 기능이 달라져요.</p>
            {state.capabilities.length ? (
              state.capabilities.map((capability) => (
                <div className="capability" key={capability.name}>
                  <span
                    className={
                      capability.supported
                        ? "supported-icon"
                        : "unsupported-icon"
                    }
                  >
                    {capability.supported ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      <Minus size={16} />
                    )}
                  </span>
                  <div>
                    <strong>
                      {capability.name}
                      <small>
                        {capability.supported ? "지원됨" : "사용 불가"}
                      </small>
                    </strong>
                    <p>{capability.detail}</p>
                  </div>
                </div>
              ))
            ) : (
              <p>지원 상태를 확인하는 중이에요.</p>
            )}
          </section>
          <section className="panel shortcut-panel">
            <h2>기록 단축키</h2>
            <div>
              <span>기록 시작 · 종료</span>
              <kbd>Ctrl ⇧ R</kbd>
            </div>
            <div>
              <span>일시정지 · 재개</span>
              <kbd>Ctrl ⇧ P</kbd>
            </div>
            <p>다른 앱과 충돌하면 단축키 등록 오류가 표시돼요.</p>
          </section>
          <div className="settings-version">
            <BrandMark small />
            <div>
              Automanager<small>데스크톱 · 0.1.0</small>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
function SettingsSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="panel settings-section">
      <div className="settings-section-heading">
        <div className="blue-icon">
          <Icon size={19} />
        </div>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      <div className="settings-section-content">{children}</div>
    </section>
  );
}
function ModelCard({
  model,
  api,
  run,
}: {
  model: ModelInfo;
  api: DesktopAPI;
  run: Run;
}) {
  return (
    <div className="model-card">
      <div>
        <strong>
          {model.name}
          <span
            className={`mini-status ${model.status === "ready" ? "ready" : model.status === "error" ? "error" : ""}`}
          >
            {
              {
                missing: "미설치",
                downloading: "다운로드 중",
                ready: "준비됨",
                error: "설치 실패",
              }[model.status]
            }
          </span>
        </strong>
        <p>
          {model.engine} · {model.languages.join(", ")} ·{" "}
          {size(model.sizeBytes)} · {model.license}
        </p>
        {model.status === "downloading" && (
          <div className="progress-track">
            <span style={{ width: `${model.progress}%` }} />
          </div>
        )}
        {model.error && <p className="inline-error">{model.error}</p>}
      </div>
      <div className="model-actions">
        <Button
          disabled={model.status === "downloading"}
          onClick={() => void run(() => api.configureEngine(model.engine))}
        >
          엔진 설정
        </Button>
        <Button
          disabled={model.status === "downloading"}
          onClick={() => void run(() => api.importModel(model.id))}
        >
          <FolderOpen size={14} />
          가져오기
        </Button>
        {model.status !== "ready" && (
          <Button
            disabled={model.status === "downloading"}
            onClick={() => void run(() => api.installModel(model.id))}
          >
            <Download size={14} />
            {model.status === "error" ? "다시 설치" : "설치"}
          </Button>
        )}
      </div>
    </div>
  );
}

function StartDialog({
  settings,
  busy,
  onClose,
  onStart,
}: {
  settings: Settings;
  busy: boolean;
  onClose: () => void;
  onStart: (title: string, audio: boolean, screen: boolean) => Promise<void>;
}) {
  const [title, setTitle] = useState(""),
    [audio, setAudio] = useState(settings.audioEnabled),
    [screen, setScreen] = useState(settings.screenEnabled);
  return (
    <Dialog
      title="새로운 기록을 시작해요"
      description="작업과 생각을 하나의 타임라인에 남겨보세요."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onStart(title, audio, screen);
        }}
      >
        <label className="field-label" htmlFor="session-title">
          기록 이름<span>선택</span>
        </label>
        <input
          id="session-title"
          aria-label="기록 이름"
          autoFocus
          placeholder="예: 서비스 기획 회의"
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="start-options">
          <Toggle
            label="화면 및 작업 단계 기록"
            description="작업의 흐름과 화면을 함께 보관해요"
            checked={screen}
            onChange={setScreen}
          />
          <Toggle
            label="마이크 음성 녹음"
            description={`${settings.chunkSeconds}초마다 별도 WAV 파일로 저장해요`}
            checked={audio}
            onChange={setAudio}
          />
        </div>
        <div className="info-note">
          <ShieldCheck size={17} />
          기록은 시작 버튼을 누른 순간부터 수집돼요.
        </div>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            취소
          </Button>
          <Button tone="primary" type="submit" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <span className="record-button-dot" />
            )}
            기록 시작
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function RenameDialog({
  session,
  busy,
  onClose,
  onSave,
}: {
  session: Session;
  busy: boolean;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(session.title);
  return (
    <Dialog title="기록 이름 변경" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) void onSave(title.trim());
        }}
      >
        <label htmlFor="rename-title" className="field-label">
          기록 이름
        </label>
        <input
          id="rename-title"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            취소
          </Button>
          <Button tone="primary" type="submit" disabled={busy || !title.trim()}>
            이름 저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function CommentDialog({
  api,
  allowRegion,
  busy,
  onClose,
  onSave,
}: {
  api: DesktopAPI;
  allowRegion?: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (text: string, rect?: Rect) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [rect, setRect] = useState<Rect | undefined>();
  const [regionError, setRegionError] = useState("");
  return (
    <Dialog
      title="작업에 주석 남기기"
      description="지금의 생각이나 확인할 내용을 함께 기록해요."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim())
            void onSave(text.trim(), allowRegion ? rect : undefined);
        }}
      >
        <label htmlFor="comment-text" className="field-label">
          주석 내용
        </label>
        <textarea
          id="comment-text"
          rows={4}
          value={text}
          maxLength={5000}
          placeholder="어떤 내용을 기억하고 싶나요?"
          onChange={(event) => setText(event.target.value)}
        />
        {allowRegion && (
          <div className="desktop-region-control">
            <Button
              type="button"
              onClick={async () => {
                setRegionError("");
                try {
                  const value = await api.selectCommentRegion();
                  if (value) setRect(value);
                } catch (error) {
                  setRegionError(errorText(error));
                }
              }}
            >
              <Monitor size={15} />
              화면에서 주석 영역 선택
            </Button>
            {rect && (
              <span>
                선택한 영역: {rect.width} × {rect.height}px
              </span>
            )}
          </div>
        )}
        {regionError && (
          <p className="inline-error" role="alert">
            {regionError}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            취소
          </Button>
          <Button
            tone="primary"
            type="submit"
            disabled={
              busy ||
              !text.trim() ||
              (allowRegion && rect && (!rect.width || !rect.height))
            }
          >
            <MessageSquare size={16} />
            주석 저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ScheduleDialog({
  schedule,
  onClose,
  onSave,
}: {
  schedule?: Schedule;
  onClose: () => void;
  onSave: (
    value: Omit<Schedule, "id" | "lastRun"> & { id?: string },
  ) => Promise<unknown>;
}) {
  const [title, setTitle] = useState(schedule?.title || ""),
    [time, setTime] = useState(schedule?.startTime || "09:00"),
    [minutes, setMinutes] = useState(schedule?.durationMinutes || 30),
    [days, setDays] = useState<number[]>(schedule?.days || []),
    [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = new Date();
    const [hour, minute] = time.split(":").map(Number);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    if (days.length)
      while (!days.includes(next.getDay())) next.setDate(next.getDate() + 1);
    setBusy(true);
    await onSave({
      ...(schedule ? { id: schedule.id } : {}),
      title: title.trim(),
      enabled: schedule?.enabled ?? true,
      startTime: time,
      durationMinutes: minutes,
      days,
      nextRun: next.getTime(),
    });
    setBusy(false);
  };
  return (
    <Dialog
      title={schedule ? "예약 수정" : "기록 예약 만들기"}
      description="앱이 실행 중인 동안 정해진 시간에 기록을 시작해요."
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="schedule-title">
          예약 이름
        </label>
        <input
          id="schedule-title"
          required
          maxLength={200}
          value={title}
          placeholder="예: 매일 업무 회고"
          onChange={(event) => setTitle(event.target.value)}
        />
        <div className="two-fields">
          <div>
            <label className="field-label" htmlFor="schedule-time">
              시작 시각
            </label>
            <input
              id="schedule-time"
              type="time"
              required
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="schedule-length">
              기록 길이 (분)
            </label>
            <input
              id="schedule-length"
              type="number"
              min="1"
              max="1440"
              required
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
          </div>
        </div>
        <label className="field-label">
          반복 요일
          <span>{days.length ? "선택한 요일마다" : "다음 시각에 한 번"}</span>
        </label>
        <div className="day-picker">
          {["일", "월", "화", "수", "목", "금", "토"].map((day, i) => (
            <button
              key={day}
              type="button"
              aria-label={`${day}요일 반복`}
              aria-pressed={days.includes(i)}
              className={days.includes(i) ? "selected" : ""}
              onClick={() =>
                setDays(
                  days.includes(i)
                    ? days.filter((value) => value !== i)
                    : [...days, i].sort(),
                )
              }
            >
              {day}
            </button>
          ))}
        </div>
        <div className="repeat-presets">
          <button type="button" onClick={() => setDays([])}>
            한 번
          </button>
          <button type="button" onClick={() => setDays([1, 2, 3, 4, 5])}>
            평일
          </button>
          <button type="button" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>
            매일
          </button>
        </div>
        <div className="dialog-actions">
          <Button type="button" onClick={onClose}>
            취소
          </Button>
          <Button tone="primary" type="submit" disabled={busy || !title.trim()}>
            <Check size={16} />
            예약 저장
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
