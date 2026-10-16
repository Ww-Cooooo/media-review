import { RepairPanel } from './components/RepairPanel';
import { VersionPanel } from './components/VersionPanel';
import { ReadinessPanel } from './components/ReadinessPanel';
import { ReviewDifference } from './components/ReviewDifference';
import { useReviewProgress, createHandoffRound, organizeTasks, STATUS_LABEL } from './lib/review-product';
import './review-product.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Alert, Badge, Button, Drawer, Dropdown, Empty, Form, Input, Modal, Popconfirm, Segmented, Select, Slider, Switch, Tag } from 'antd';
import { ArrowLeftOutlined, AudioOutlined, CheckOutlined, ClockCircleOutlined, CloseOutlined, CommentOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, HomeOutlined, InfoCircleOutlined, PauseOutlined, PlayCircleOutlined, PlusOutlined, RedoOutlined, SafetyCertificateOutlined, SaveOutlined, ScissorOutlined, SelectOutlined, SoundOutlined, UndoOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { FullscreenOutlined, FullscreenExitOutlined, ExpandAltOutlined, ShrinkOutlined } from '@ant-design/icons';
import { ReactLenis } from 'lenis/react';
import { useVideoPresentation } from './lib/use-video-presentation';
import './video-presentation.css';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ServiceBadge } from './components/ServiceBadge';
import { ServiceNotice, ServiceRecoveryButton } from './components/ServiceNotice';
import { ReviewHome } from './components/ReviewHome';
import { ReviewTasks } from './components/ReviewTasks';
import { WaveData } from './components/WaveData';
import { useRegionHistory } from './lib/use-region-history';
import { useReviewTasks } from './lib/use-review-tasks';
import { useAnalysisLocator } from './lib/use-analysis-locator';
import { AnalysisActivityNotice } from './components/AnalysisActivityNotice';
import './review-lifecycle.css';
import { FrameCanvas, FrameRegions } from './components/FrameCanvas';
import { VideoPreview } from './components/VideoPreview';
import { ReviewWaveform } from './components/ReviewWaveform';
import FrameStrip from './components/FrameStrip';
import { AudioCompare } from './components/AudioCompare';
import { TranscriptPanel, type TranscriptCue } from './components/TranscriptPanel';
import { ReviewHandoffDialog } from './components/ReviewHandoffDialog';
import { createReviewHandoff, type ReviewHandoff } from './lib/review-handoff';
import { loadRecord, saveRecord, loadReference, saveReference, workflowFile, loadWorkspace, saveWorkspace, archiveWorkspace, exportRecord, registerManualTask, claimEditing, heartbeat, releaseClient, changeTaskStatus, serviceSummary, closeService, nativeLauncher, restartInfo, restartService, type NativeLauncher, setReviewContext, reviewContext, REVIEW_CLIENT_ID, ReviewAPIError, getTask, type ReviewTask } from './lib/api';
import { useServiceStatus } from './lib/use-service-status';
import { cacheWorkspace, cachedWorkspace, type ReviewWorkspace } from './lib/review-workspace';
import { useMediaAnalysis } from './lib/use-media-analysis';
import { emptyDraft, hasDraftWork, draftMarks, clearedDraftMarks, draftProblem, draftSignature, draftToNote, type ReviewDraft, type TargetMode } from './lib/review-draft';
import { clampMs, fingerprintFile, formatTime, KIND_LABEL, parseTime, REFERENCE_FORMAT, REVIEW_FORMAT, REGIONS_FORMAT, FLOW_FORMAT, COMPLETE_FORMAT, regionsOf, sortedNotes, TOPIC_LABEL, type MediaIdentity, type Rect, type ReviewRecord, type ReviewNote, type ReviewTopic } from './lib/review';

interface OpenMedia { file: File; local: boolean; url: string; isAudio: boolean; identity: MediaIdentity; width: number; height: number }
type View = { kind: 'new' } | { kind: 'detail'; id: string } | { kind: 'edit'; id: string };
type Action = { type: 'new' } | { type: 'target'; mode: TargetMode; position: number; cue?: TranscriptCue; marker?: boolean } | { type: 'detail'; note: ReviewNote } | { type: 'restore' } | { type: 'file'; file: File; task?: ReviewTask; newTask?: boolean; readOnly?: boolean } | { type: 'task'; task: ReviewTask; readOnly?: boolean } | { type: 'suspend' } | { type: 'end' } | { type: 'exit' } | { type: 'finish' };
const MODE_LABEL = { point: '时间点', range: '时间段', frame: '画面位置', whole: '整片意见' };
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
function fromNote(note: ReviewNote): ReviewDraft {
  const regions = regionsOf(note);
  // Region-only notes use this compatibility summary on disk, not as user input.
  const text = note.text === '见各编号区域说明' && regions.some(region => region.text?.trim()) ? '' : note.text;
  return { id: note.id, mode: note.scope === 'whole' ? 'whole' : note.endMs !== null ? 'range' : note.reference && regionsOf(note).length ? 'frame' : 'point', kind: note.kind, topic: note.topic ?? null,
    startText: note.startMs === null ? '' : formatTime(note.startMs), endText: note.endMs === null ? '' : formatTime(note.endMs), text, regions, ...(note.regionSerial !== undefined ? { regionSerial: note.regionSerial } : {}),
    frameMs: note.reference?.frameMs ?? null, reference: note.reference ?? null, snapshot: null };
}

export function ReviewDesk() {
  const { message } = App.useApp();
  const root = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), player = useRef<HTMLMediaElement>(null), stage = useRef<HTMLDivElement>(null);
  const videoSurface = useRef<HTMLElement>(null), requestedTask = useRef(new URLSearchParams(location.search).get('task'));
  const generation = useRef(0), savingRef = useRef(false), captureSequence = useRef(0), copySequence = useRef(0), gestureBackup = useRef<ReviewDraft | null>(null);
  const auditionEnd = useRef<number | null>(null), oldVolume = useRef(75);
  const [media, setMedia] = useState<OpenMedia | null>(null);
  const [screen, setScreen] = useState<'home' | 'review'>('home');
  const [notes, setNotes] = useState<ReviewNote[]>([]), [dirty, setDirty] = useState(false);
  const [newDraft, setNewDraft] = useState(emptyDraft), [editDraft, setEditDraft] = useState(emptyDraft), [parked, setParked] = useState<ReviewDraft[]>([]);
  const [completion, setCompletion] = useState<ReviewRecord['completion']>(null);
  const [deletedNotes, setDeletedNotes] = useState<ReviewNote[]>([]);
  const [view, setView] = useState<View>({ kind: 'new' });
  const [pending, setPending] = useState<Action | null>(null), [busy, setBusy] = useState<'opening' | 'loading' | 'saving' | null>(null);
  const [selecting, setSelecting] = useState<'range' | 'frame' | null>(null), [capturing, setCapturing] = useState(false);
  const [clearedMarks, setClearedMarks] = useState<ReturnType<typeof draftMarks> | null>(null);
  const [feedback, setFeedback] = useState(''), [recordError, setRecordError] = useState(''), [mediaError, setMediaError] = useState('');
  const [recordPath, setRecordPath] = useState<string | null>(null), [saved, setSaved] = useState(false), [loadAttempt, setLoadAttempt] = useState(0);
  const [currentMs, setCurrentMs] = useState(0), [playing, setPlaying] = useState(false), [listenOnly, setListenOnly] = useState(false);
  const [rate, setRate] = useState(1), [volume, setVolume] = useState(75), [zoom, setZoom] = useState(1), [viewStart, setViewStart] = useState(0);
  const [loop, setLoop] = useState(false), [contrast, setContrast] = useState(true), [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [images, setImages] = useState<Record<string, string>>({}), [imageError, setImageError] = useState(''), [referenceOpen, setReferenceOpen] = useState(false);
  const [handoff, setHandoff] = useState<ReviewHandoff | null>(null), [handoffOpen, setHandoffOpen] = useState(false);
  const [copied, setCopied] = useState(false), [copying, setCopying] = useState(false), [copyError, setCopyError] = useState('');
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [versionOpen, setVersionOpen] = useState(false), [readinessOpen, setReadinessOpen] = useState(false);
  const [noteQuery, setNoteQuery] = useState(''), [topicFilter, setTopicFilter] = useState(''), [progressFilter, setProgressFilter] = useState('');
  const [selectedRegion, setSelectedRegion] = useState<number | null>(null), [contextPad, setContextPad] = useState(1000), [fineStep, setFineStep] = useState(40);
  const [importedCues, setImportedCues] = useState<TranscriptCue[] | null>(null);
  const manualParent = useRef<string | null>(null);
  const [captureCount, setCaptureCount] = useState(0);
  const service = useServiceStatus();
  const [launcher, setLauncher] = useState<NativeLauncher | null>(null);
  const [recoveryWait, setRecoveryWait] = useState<{ kind: 'start' | 'restart'; runtimeId: string } | null>(null);
  const [launchFeedback, setLaunchFeedback] = useState('');
  const recoveryAction = useRef(false);
  useEffect(() => {
    if (service.state !== 'online') return;
    let stopped = false;
    void nativeLauncher().then(value => {
      if (!stopped) setLauncher(value.available && value.uri !== `media-review-${service.dataId}://start` ? { ...value, available: false, uri: null, reason: '启动入口与当前资料根不匹配，未唤起。' } : value);
    }).catch(() => { /* 入口查询失败不抹去本页已核验的离线唤起地址。 */ });
    return () => { stopped = true; };
  }, [service.state, service.runtimeId, service.dataId]);
  useEffect(() => {
    if (!recoveryWait) return;
    if (service.state === 'online' && (recoveryWait.kind === 'start' || service.runtimeId !== recoveryWait.runtimeId)) {
      recoveryAction.current = false; setRecoveryWait(null); setLaunchFeedback(''); message.success('Media Review本机服务已重新连接；当前任务与保存权限继续单独核验。'); return;
    }
    const timer = setTimeout(() => {
      recoveryAction.current = false; setRecoveryWait(null);
      setLaunchFeedback('尚未确认Media Review恢复连接。可能取消了系统确认、入口被安全软件阻止、端口已变化或存在版本冲突。请保留旧页输入，检查系统提示，必要时从桌面入口重开；不要关闭防护。');
    }, 60_000);
    return () => clearTimeout(timer);
  }, [recoveryWait, service.state, service.runtimeId, message]);
  function requestNativeStart() {
    if (recoveryAction.current || !launcher?.rootId) return false;
    recoveryAction.current = true; setLaunchFeedback(''); setRecoveryWait({ kind: 'start', runtimeId: service.runtimeId });
    window.dispatchEvent(new CustomEvent('review-native-start', { detail: { rootId: launcher.rootId, dataId: service.dataId } }));
    return true;
  }
  const serviceError = service.state === 'incompatible' ? '当前页面与服务身份或版本不兼容。请保留输入，从桌面的“Media Review”或当前启动文件重新打开。' : '';
  const tasks = useReviewTasks(service.state === 'online');
  const [activeTask, setActiveTask] = useState<ReviewTask | null>(null), [editing, setEditing] = useState(false), [tasksOpen, setTasksOpen] = useState(false);
  const [recordRevision, setRecordRevision] = useState<string | null>(null), [primary, setPrimary] = useState(false);
  const [frameIndexOpen, setFrameIndexOpen] = useState(false), [compareOpen, setCompareOpen] = useState(false), [visible, setVisible] = useState(!document.hidden);
  const [conflict, setConflict] = useState<{ latest: Awaited<ReturnType<typeof loadRecord>>; finish: boolean; allDrafts: boolean; proposed: ReviewNote[] } | null>(null);
  const manualRequest = useRef({ generation: -1, id: '' });
  const chosenNewTask = useRef(false), chosenReadOnly = useRef(false), manualNewTask = useRef(false);
  const chosenManualTask = useRef<ReviewTask | null>(null), initialPick = useRef(false), manualRegistration = useRef('');
  const [baseNotes, setBaseNotes] = useState<ReviewNote[]>([]);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveryConflict, setRecoveryConflict] = useState<ReviewWorkspace | null>(null), [recoveryCompare, setRecoveryCompare] = useState(false);
  const [exportPath, setExportPath] = useState(''), [exporting, setExporting] = useState(false);
  const restoring = useRef(true);
  const workspaceTail = useRef<Promise<unknown>>(Promise.resolve());
  const durationMs = media?.identity.durationMs ?? 0;
  const presentation = useVideoPresentation(videoSurface, screen === 'review' && !!media && !media.isAudio && !listenOnly, text => message.info(text));
  const analysis = useMediaAnalysis(media?.file ?? null, durationMs, editing && !!activeTask && service.state === 'online' && screen === 'review', activeTask && media?.local ? { ...activeTask, manual: true } : activeTask);
  const progress = useReviewProgress(activeTask?.id, service.state === 'online', recordRevision);
  const ordered = useMemo(() => sortedNotes(notes).filter(note => (!noteQuery || [note.text, ...regionsOf(note).map(region => region.text ?? ''), progress.bundle?.statuses[note.id]?.latest?.text ?? ''].join(' ').toLocaleLowerCase().includes(noteQuery.toLocaleLowerCase())) && (!topicFilter || note.topic === topicFilter) && (!progressFilter || (progress.bundle?.statuses[note.id]?.status ?? (note.kind === 'discuss' ? 'clarify' : 'pending')) === progressFilter)), [notes, noteQuery, topicFilter, progressFilter, progress.bundle]);
  function focusRegion(id: number) { setSelectedRegion(id); setTimeout(() => root.current?.querySelector<HTMLElement>(view.kind === 'detail' ? `[data-region-comment="${id}"]` : '#opinion-text')?.scrollIntoView({ block: 'nearest' }), 0); }
  function nextIssue() { if (!ordered.length) return; const index = ordered.findIndex(note => view.kind !== 'new' && note.id === view.id); showNote(ordered[(index + 1) % ordered.length]); }
  useEffect(() => {
    const note = view.kind !== 'new' ? notes.find(item => item.id === view.id) : null;
    setSelectedRegion(note && !fromNote(note).text.trim() ? regionsOf(note).find(region => region.text?.trim())?.id ?? null : null);
  }, [activeTask?.id, view.kind, view.kind === 'new' ? '' : view.id]);
  useEffect(() => { setNoteQuery(''); setTopicFilter(''); setProgressFilter(''); setImportedCues(null); if (activeTask) void organizeTasks([activeTask.id], 'opened').catch(() => {}); }, [activeTask?.id]);
  const selected = view.kind !== 'new' ? notes.find(note => note.id === view.id) : null;
  const draft = view.kind === 'detail' && selected ? fromNote(selected) : view.kind === 'edit' ? editDraft : newDraft;
  const reading = view.kind === 'detail';
  const regions = regionsOf(draft);
  const commentRegion = regions.find(region => region.id === selectedRegion);
  const regionHistory = useRegionHistory(`${activeTask?.id}:${view.kind}:${draft.id}:${draft.frameMs}`);
  useEffect(() => { setClearedMarks(null); }, [activeTask?.id, view.kind, draft.id]);
  useEffect(() => { setDeletedNotes([]); setCompletion(null); }, [media?.url]);
  const editChanged = view.kind === 'edit' && !!selected && draftSignature(editDraft) !== draftSignature(fromNote(selected));
  const unsaved = dirty || hasDraftWork(newDraft) || editChanged || parked.some(hasDraftWork);
  const locked = !!busy || capturing || !!recordError || !!recoveryConflict || !!serviceError || !durationMs || !editing || !activeTask;
  const selectionBlocksSave = selecting === 'range' || capturing;
  const problem = draftProblem(draft, durationMs, selectionBlocksSave);
  const referenceAspect = draft.reference ? draft.reference.width / draft.reference.height : media ? media.width / media.height : 1;
  const targetImage = draft.snapshot ?? (draft.reference ? images[draft.reference.fileName] : null);
  const span = durationMs / zoom, viewEnd = Math.min(durationMs, viewStart + span);
  const start = parseTime(draft.startText), end = parseTime(draft.endText);
  const selection = draft.mode === 'range' && start !== null && end !== null && end > start && end <= durationMs ? { start, end } : null;
  const pendingRange = !reading && draft.mode === 'range' && start !== null && !draft.endText;
  const targetTime = draft.frameMs ?? start;
  const atReference = draft.frameMs !== null && Math.abs(currentMs - draft.frameMs) < 80;
  const stateLabel = busy === 'saving' ? '正在保存到本机…' : recordError ? '旧记录保留，读取待重试' : unsaved ? '有未保存的意见' : saved ? '已保存到本机' : '尚未保存';
  const activeCue = (importedCues ?? analysis.cues).find(cue => cue.startMs <= currentMs && currentMs < cue.endMs);
  const activity = useRef({ media, activeTask, busy, unsaved, editing, workspace: null as ReviewWorkspace | null });
  activity.current = { media, activeTask, busy, unsaved, editing, workspace: media && durationMs ? { format: 'media-review-workspace/v4', media: media.identity, currentMs: clampMs(Math.round((player.current?.currentTime ?? currentMs / 1000) * 1000), durationMs), notes, baseNotes, dirty, newDraft, editDraft, parked, view } : null };

  const analysisLocator = useAnalysisLocator(service.state === 'online', service.dataId, service.runtimeId, activeTask?.id ?? null, () => {
    if (!activity.current.media) return;
    navigate('review'); requestAnimationFrame(() => root.current?.querySelector('.transcript-content')?.scrollIntoView({ block: 'center', behavior: 'instant' }));
  }, item => {
    const target = item.tasks.find(task => item.pages.some(page => page.taskId === task.id)) ?? item.tasks[0];
    if (!target) { message.info('旧入口没有登记可定位的任务，无法安全跳转；当前输入仍保留，请核对原校对窗口。'); return; }
    Modal.confirm({ title: item.pages.length ? '浏览器未确认切到原校对页' : '原校对页暂无响应，在本页定位？', content: <><p>正在处理：{item.mediaName}</p><p>校对任务：{target.title} · {target.id.slice(0, 8)}。所属本机服务：{location.host}。</p><p>不会另开浏览器、取消原分析或抢编辑权。本页有未保存输入时，仍会先提示保留。{target.manual ? '这份素材由用户手选，需要重新选择同一版本；不会读取其他文件。' : '可在本页加载只读对照，不额外启动分析。'}</p></>, okText: target.manual ? '选择同版素材定位' : '在本页只读定位', cancelText: '保留当前页面', onOk: async () => {
      const { task } = await getTask(target.id); request({ type: 'task', task, readOnly: true });
    } });
  }, text => message.info(text));

  function navigate(next: 'home' | 'review', history = true) {
    player.current?.pause(); setScreen(next); setSelecting(null); captureSequence.current++; setCapturing(false);
    if (history) window.history.pushState({ screen: next }, '', next === 'home' ? '#home' : '#review');
  }
  useEffect(() => {
    const pop = () => { player.current?.pause(); setSelecting(null); setScreen(location.hash === '#review' && media ? 'review' : 'home'); };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, [media]);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches); query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (unsaved) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [unsaved]);
  useEffect(() => { const url = media?.url; return () => { if (url) URL.revokeObjectURL(url); }; }, [media?.url]);
  useEffect(() => { if (player.current) player.current.volume = volume / 100; }, [volume, media?.url]);
  const invalidate = useCallback(() => {
    copySequence.current++; setHandoff(null); setHandoffOpen(false); setCopied(false); setCopyError(''); setCopying(false); setFeedback(''); setSaved(false);
  }, []);
  function patch(change: Partial<ReviewDraft>, remember = true) {
    if (locked || reading) return;
    invalidate();
    if (['mode', 'startText', 'endText', 'frameMs', 'regions'].some(key => key in change)) setClearedMarks(null);
    if (change.regions && remember) regionHistory.remember(regions, change.regions);
    const update = (old: ReviewDraft) => {
      const next = { ...old, ...change };
      if (change.regions) {
        delete next.rect;
        next.regionSerial = Math.max(old.regionSerial ?? 0, ...regionsOf(old).map(item => item.id), ...change.regions.map(item => item.id));
        if (!change.regions.length && next.mode === 'frame') next.mode = 'point';
      }
      return next;
    };
    if (view.kind === 'edit') setEditDraft(update); else setNewDraft(update);
  }
  function undoRegion(redo = false) {
    if (locked || reading) return;
    const value = regionHistory.take(regions, redo); if (value) patch({ regions: value }, false);
  }
  function clearMarks(timeOnly = false) {
    if (locked || reading) return;
    const previous = draftMarks(draft);
    patch(clearedDraftMarks(draft, timeOnly), false);
    setClearedMarks(previous); setSelecting(null); gestureBackup.current = null;
    setSelectedRegion(null); setLoop(false); regionHistory.clear();
  }
  function restoreClearedMarks() {
    if (locked || reading || !clearedMarks) return;
    patch(clearedMarks, false); regionHistory.clear();
  }
  function removeNote(note: ReviewNote) {
    setDeletedNotes(old => [...old, note].slice(-30));
    setNotes(old => old.filter(item => item.id !== note.id));
    if (view.kind === 'edit') setEditDraft(emptyDraft());
    setView({ kind: 'new' }); setDirty(true); invalidate();
  }
  function undoNoteDeletion() {
    if (locked || !deletedNotes.length) return;
    const note = deletedNotes[deletedNotes.length - 1];
    setNotes(old => old.some(item => item.id === note.id) ? old : sortedNotes([...old, note]));
    setDeletedNotes(old => old.slice(0, -1)); setDirty(true); invalidate();
  }
  function focusOpinion() {
    if (presentation.expanded || presentation.fullscreen) { void presentation.leave().then(() => requestAnimationFrame(focusOpinionInput)); return; }
    requestAnimationFrame(focusOpinionInput);
  }
  function focusOpinionInput() {
      const input = root.current?.querySelector<HTMLTextAreaElement>('#opinion-text');
      if (!input) return;
      const bounds = input.getBoundingClientRect();
      if (bounds.bottom > innerHeight - 20 || bounds.top < 100) input.scrollIntoView({ block: 'nearest', behavior: reduced ? 'instant' : 'smooth' });
      input.focus({ preventScroll: true });
  }
  function actualTime() { return clampMs(Math.round((player.current?.currentTime ?? currentMs / 1000) * 1000), durationMs); }
  function seek(ms: number) {
    if (!player.current || !durationMs) return;
    const next = clampMs(ms, durationMs); auditionEnd.current = null;
    if (selecting === 'frame') { setSelecting(null); gestureBackup.current = null; }
    player.current.currentTime = next / 1000; setCurrentMs(next);
    if (next < viewStart || next > viewEnd) setViewStart(Math.max(0, Math.min(durationMs - span, next - span * .2)));
  }
  async function togglePlay() {
    if (!player.current || capturing) return;
    if (!player.current.paused) { player.current.pause(); auditionEnd.current = null; return; }
    setSelecting(null);
    try { await player.current.play(); } catch { setMediaError('浏览器暂时无法播放，请检查媒体编码。'); }
  }
  function onTimeUpdate(event: React.SyntheticEvent<HTMLMediaElement>) {
    const element = event.currentTarget;
    let time = clampMs(Math.round(element.currentTime * 1000), durationMs);
    if (auditionEnd.current !== null && time >= auditionEnd.current) { time = auditionEnd.current; auditionEnd.current = null; element.pause(); element.currentTime = time / 1000; }
    if (loop && selection && time >= Math.min(durationMs, selection.end + contextPad) - 30) { time = Math.max(0, selection.start - contextPad); element.currentTime = time / 1000; }
    setCurrentMs(time);
    if (zoom > 1 && time > viewEnd) setViewStart(Math.min(durationMs - span, Math.max(0, time - span * .2)));
  }

  useEffect(() => {
    if (!media || !durationMs || !activeTask) return;
    const number = generation.current, context = reviewContext(); let cancelled = false;
    restoring.current = true; setBusy('loading'); setRecordError('');
    void (async () => {
      const result = await loadRecord(media.identity.fingerprint, context);
      if (cancelled || number !== generation.current) return;
      const record = result.record;
      if (result.found && record && (![REVIEW_FORMAT, REFERENCE_FORMAT, REGIONS_FORMAT, FLOW_FORMAT, COMPLETE_FORMAT].includes(record.format) || record.media.fingerprint !== media.identity.fingerprint || record.media.size !== media.identity.size || record.media.name !== media.identity.name || Math.abs(record.media.durationMs - durationMs) > 1000)) throw new Error('找到记录但媒体身份不匹配，原意见未加载或覆盖。');
      const original = record?.notes ?? [];
      setNotes(original); setBaseNotes(original); setRecordRevision(result.revision); setRecordPath(result.recordPath); setSaved(!!record); setCompletion(record?.completion ?? null);
      if (record?.completion && result.recordPath && editing && result.revision) { const round = await createHandoffRound(activeTask.id, result.revision).catch(() => null); if (round && !cancelled) setHandoff(createReviewHandoff({ saved: true, fileName: media.identity.fingerprint + '.review.json', recordPath: round.recordPath, record, savedAt: record.completion.completedAt, revision: result.revision }, round)); }
      if (!editing) return;
      const [disk, local, legacy] = await Promise.all([
        loadWorkspace(media.identity.fingerprint, context).catch(() => { setRecoveryStatus('本机恢复资料暂不可读，原内容保留'); return { workspace: null, at: 0 }; }),
        cachedWorkspace(service.dataId, media.identity.fingerprint, context).catch(() => null),
        activeTask.legacy ? cachedWorkspace(service.rootId, media.identity.fingerprint).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled || number !== generation.current) return;
      const cached = local && (!legacy || local.at >= legacy.at) ? local : legacy;
      const restored = cached && cached.at > disk.at ? cached.workspace : disk.workspace;
      if (restored && restored.media.fingerprint === media.identity.fingerprint && restored.media.name === media.identity.name && restored.media.size === media.identity.size && restored.media.durationMs === durationMs) {
        const sameBase = JSON.stringify(restored.baseNotes) === JSON.stringify(original);
        if (!sameBase && restored.dirty) { setRecoveryStatus('正式意见与旧恢复副本不同，请先比对；两个版本均保留。'); setRecoveryConflict(restored); setRecoveryCompare(true); return; }
        setNotes(sameBase ? restored.notes : original); setDirty(sameBase && restored.dirty);
        setNewDraft(restored.newDraft); setEditDraft(restored.editDraft); setParked(restored.parked);
        const restoredView = restored.view;
        setView(restoredView.kind === 'new' || (sameBase ? restored.notes : original).some(note => note.id === restoredView.id) ? restoredView : { kind: 'new' });
        if (player.current) player.current.currentTime = restored.currentMs / 1000;
        setCurrentMs(restored.currentMs); setRecoveryStatus('已恢复上次素材位置与意见草稿；恢复副本不等于正式保存');
      }
    })().catch(cause => { if (!cancelled) setRecordError(cause instanceof Error ? cause.message : '记录无法读取，原文件保留。'); })
      .finally(() => { if (!cancelled && number === generation.current) { restoring.current = false; setBusy(null); } });
    return () => { cancelled = true; };
  }, [activeTask?.id, media?.identity.fingerprint, durationMs, loadAttempt, service.dataId]);
  useEffect(() => {
    if (!media || !durationMs || activeTask || service.state !== 'online' || manualRegistration.current === String(generation.current)) return;
    const number = generation.current; manualRegistration.current = String(number);
    if (manualRequest.current.generation !== number) manualRequest.current = { generation: number, id: crypto.randomUUID() };
    void registerManualTask(media.identity, manualRequest.current.id, media.file.lastModified, manualNewTask.current, manualParent.current).then(async ({ task }) => {
      if (number !== generation.current) return;
      const lease = await claimEditing(task);
      if (number !== generation.current) return;
      setReviewContext(task.id, lease.leaseId); setEditing(lease.editing); setActiveTask(task); void tasks.refresh();
    }).catch(cause => {
      if (number !== generation.current) return;
      manualRegistration.current = ''; setRecordError(cause instanceof Error ? cause.message : '手选任务未登记，请重试；本页文件保留');
    });
  }, [media?.url, durationMs, activeTask?.id, service.state, loadAttempt]);
  useEffect(() => {
    const reference = draft.reference, fingerprint = media?.identity.fingerprint;
    setImageError('');
    if (!reference || !fingerprint || images[reference.fileName]) return;
    let cancelled = false;
    void loadReference(fingerprint, reference.fileName).then(result => { if (!cancelled) setImages(old => Object.fromEntries(Object.entries({ ...old, [reference.fileName]: result.data }).slice(-8))); })
      .catch(() => { if (!cancelled) setImageError('参考图暂不能读取。原时间和坐标仍在，请回源核对；不会补成其他帧。'); });
    return () => { cancelled = true; };
  }, [draft.reference?.fileName, media?.identity.fingerprint, images]);
  useEffect(() => {
    const element = stage.current;
    if (!element || !media || screen !== 'review') return;
    const fit = () => {
      const aspect = media.width / media.height;
      const width = Math.max(1, Math.min(element.clientWidth - 44, Math.max(1, element.clientHeight - 28) * aspect));
      setFrameSize({ width, height: width / aspect });
    };
    const observer = new ResizeObserver(fit); observer.observe(element); fit();
    return () => observer.disconnect();
  }, [media?.url, media?.width, media?.height, listenOnly, screen, presentation.expanded, presentation.fullscreen]);

  useGSAP(() => {
    if (screen !== 'home') return;
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const cleanups: (() => void)[] = [];
      root.current?.querySelectorAll<HTMLElement>('.file-choice').forEach(button => {
        const face = button.querySelector('.file-face'), arrow = button.querySelector('.file-pick .anticon');
        const base = button.querySelector('.audio-file') ? 4 : -4;
        let hover = false, focus = false, press = false;
        const paint = () => {
          gsap.to(face, { y: press ? 2 : hover || focus ? -7 : 0, rotation: hover || focus ? 0 : base, scale: press ? .985 : 1, duration: press ? .09 : .24, overwrite: 'auto', ease: 'power2.out' });
          gsap.to(arrow, { x: (hover || focus) && !press ? 5 : 0, duration: .24, overwrite: 'auto' });
        };
        const events: Record<string, EventListener> = {
          pointerenter: () => { hover = true; paint(); }, pointerleave: () => { hover = false; press = false; paint(); },
          pointerdown: () => { press = true; paint(); }, pointerup: () => { press = false; paint(); }, pointercancel: () => { press = false; hover = false; paint(); },
          focus: () => { focus = button.matches(':focus-visible'); paint(); }, blur: () => { focus = false; press = false; paint(); },
          keydown: event => { if (['Enter', ' '].includes((event as KeyboardEvent).key)) { press = true; paint(); } }, keyup: () => { press = false; paint(); },
        };
        Object.entries(events).forEach(([name, callback]) => button.addEventListener(name, callback));
        cleanups.push(() => { Object.entries(events).forEach(([name, callback]) => button.removeEventListener(name, callback)); gsap.killTweensOf([face, arrow]); gsap.set(face, { clearProps: 'all' }); gsap.set(arrow, { clearProps: 'all' }); });
      });
      return () => cleanups.forEach(cleanup => cleanup());
    });
    return () => mm.revert();
  }, { scope: root, dependencies: [screen], revertOnUpdate: true });
  useGSAP(() => {
    if (!captureCount || reduced || screen !== 'review') return;
    const source = root.current?.querySelector('.video-holder'), target = root.current?.querySelector<HTMLImageElement>('.target-preview img');
    if (!source || !target) return;
    const from = source.getBoundingClientRect(), to = target.getBoundingClientRect();
    const clone = document.createElement('img'); clone.src = target.src; clone.className = 'snapshot-flight'; clone.alt = ''; clone.setAttribute('aria-hidden', 'true');
    Object.assign(clone.style, { position: 'fixed', left: `${from.x}px`, top: `${from.y}px`, width: `${from.width}px`, height: `${from.height}px`, pointerEvents: 'none', zIndex: '100', transformOrigin: '0 0' });
    document.body.append(clone);
    const tween = gsap.to(clone, { x: to.x - from.x, y: to.y - from.y, scaleX: to.width / from.width, scaleY: to.height / from.height, duration: .62, ease: 'power2.inOut', onComplete: () => clone.remove() });
    return () => { tween.kill(); clone.remove(); };
  }, { scope: root, dependencies: [captureCount, reduced, screen], revertOnUpdate: true });

  async function captureFrame(position: number, value: ReviewDraft, editing = false) {
    const element = player.current;
    if (!(element instanceof HTMLVideoElement)) return;
    const sequence = ++captureSequence.current;
    setCapturing(true); setFeedback('');
    try {
      const started = performance.now();
      while (element.readyState < 2 || element.seeking) {
        if (performance.now() - started > 4000 || sequence !== captureSequence.current) throw new Error('参考画面尚未就绪，请稍后重新取得。');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      if (sequence !== captureSequence.current || !element.paused || Math.abs(element.currentTime * 1000 - position) > 80) throw new Error('播放位置已改变，请在当前画面重新框选。');
      const scale = Math.min(1, 1600 / Math.max(element.videoWidth, element.videoHeight));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(element.videoWidth * scale)); canvas.height = Math.max(1, Math.round(element.videoHeight * scale));
      const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法取得参考画面。');
      context.drawImage(element, 0, 0, canvas.width, canvas.height);
      const captured = { ...value, frameMs: position, snapshot: canvas.toDataURL('image/jpeg', .9), reference: null };
      canvas.width = 0; canvas.height = 0;
      if (editing) setEditDraft(captured); else { setView({ kind: 'new' }); setNewDraft(captured); }
      invalidate(); setCaptureCount(count => count + 1);
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : '参考画面未取得，意见仍保留。'); }
    finally { if (sequence === captureSequence.current) setCapturing(false); }
  }

  async function openFile(file: File, task: ReviewTask | null = null, local = true, newTask = false, readOnly = false) {
    manualNewTask.current = newTask;
    if (savingRef.current) return;
    const isAudio = file.type.startsWith('audio/') || /\.(m4a|mp3|wav|aac|ogg|flac)$/i.test(file.name);
    if (!isAudio && !file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) { message.error('请选择浏览器能播放的视频或音频。'); return; }
    const number = ++generation.current; captureSequence.current++; setCapturing(false);
    player.current?.pause(); analysis.stop(); setBusy('opening'); message.destroy();
    try {
      const fingerprint = await fingerprintFile(file); if (number !== generation.current) return;
      if (task && (fingerprint !== task.media.fingerprint || file.name !== task.media.name || file.size !== task.media.size || local && task.media.mtimeMs > 0 && file.lastModified !== Math.trunc(task.media.mtimeMs))) throw new Error('所选文件不属于这个任务，原意见未迁移。请选择同一版本或新建任务。');
      if (!task || reviewContext().taskId !== task.id) {
        await releaseClient().catch(() => {});
        setReviewContext(null, null); setEditing(false);
        if (task) { const lease = readOnly ? { editing: false, leaseId: null } : await claimEditing(task); setReviewContext(task.id, lease.leaseId); setEditing(lease.editing); }
      }
      if (number !== generation.current) return;
      setActiveTask(task); setRecordRevision(null); setFrameIndexOpen(false); setCompareOpen(false); setConflict(null); setRecoveryConflict(null); setRecoveryCompare(false);
      setMedia({ file, local, url: URL.createObjectURL(file), isAudio, identity: { name: file.name, size: file.size, type: task?.media.type || file.type || (isAudio ? 'audio/unknown' : 'video/unknown'), durationMs: 0, fingerprint }, width: 16, height: 9 });
      setNotes([]); setBaseNotes([]); setNewDraft(emptyDraft()); setEditDraft(emptyDraft()); setParked([]); setView({ kind: 'new' }); setSelecting(null); setDirty(false); invalidate();
      setRecordPath(null); setRecordError(''); setRecoveryStatus(''); setMediaError(''); setImages({}); setImageError(''); setReferenceOpen(false); setLoop(false); setRate(1); setCurrentMs(0); setZoom(1); setViewStart(0); setListenOnly(isAudio);
      initialPick.current = true; setTasksOpen(false); navigate('review');
    } catch (cause) { message.error(cause instanceof Error ? cause.message : '素材无法读取。'); setBusy(null); }
  }
  function chooseFile(kind?: 'video' | 'audio', task: ReviewTask | null = null, newTask = false, readOnly = false, previousTaskId: string | null = null) {
    manualParent.current = previousTaskId;
    if (serviceError) { message.error(serviceError); return; }
    if (busy === 'saving' || !fileInput.current) return;
    chosenManualTask.current = task; chosenNewTask.current = newTask; chosenReadOnly.current = readOnly;
    fileInput.current.accept = kind === 'video' ? 'video/*,.mp4,.mov,.webm' : kind === 'audio' ? 'audio/*,.wav,.m4a,.mp3,.flac' : 'audio/*,video/*,.mp4,.wav,.m4a,.mp3';
    fileInput.current.click();
  }
  function metadata() {
    const element = player.current;
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return;
    const duration = Math.round(element.duration * 1000);
    setMedia(old => old ? { ...old, identity: { ...old.identity, durationMs: duration }, width: element instanceof HTMLVideoElement ? element.videoWidth : 16, height: element instanceof HTMLVideoElement ? element.videoHeight : 9 } : old);
    setBusy(old => old === 'opening' ? null : old);
  }
  function cancelSelection() {
    captureSequence.current++; setCapturing(false); setSelecting(null);
    const previous = gestureBackup.current;
    if (previous) {
      const restoreTarget = (current: ReviewDraft) => {
        if (selecting === 'range') return { ...current, mode: previous.mode, startText: previous.startText, endText: previous.endText };
        const { rect: _rect, ...kept } = current;
        return { ...kept, regions: regionsOf(previous), frameMs: previous.frameMs, reference: previous.reference, snapshot: previous.snapshot };
      };
      if (view.kind === 'edit') setEditDraft(restoreTarget); else setNewDraft(restoreTarget);
    }
    gestureBackup.current = null; regionHistory.clear();
  }
  async function openTask(task: ReviewTask, readOnly = false) {
    if (task.status !== 'waiting' && !readOnly) { setRecoveryStatus('此任务已结束或属于尚未选择的旧交接。请在任务列表明确重开／继续，未自动改变状态。'); tasks.setClosed(true); setTasksOpen(true); return; }
    if (activity.current.activeTask?.id === task.id && activity.current.media) { setTasksOpen(false); navigate('review'); return; }
    if (task.manual) { chooseFile(undefined, task, false, readOnly); return; }
    const number = ++generation.current;
    setBusy('opening');
    try {
      await workspaceTail.current.catch(() => {});
      if (readOnly) await releaseClient();
      const lease = readOnly ? { editing: false, leaseId: null } : await claimEditing(task);
      if (number !== generation.current) return;
      if (!lease.editing && !readOnly) {
        setBusy(null);
        Modal.confirm({ title: '这个任务正在另一个窗口编辑', content: '本页不会自动加载另一份视频或重复分析。可以明确加载只读对照；接管编辑需另行确认。', okText: '加载只读对照', cancelText: '不加载，保留当前页面', onOk: () => openTask(task, true) }); return;
      }
      player.current?.pause(); analysis.stop(); setMedia(null); setActiveTask(task); setEditing(lease.editing); setReviewContext(task.id, lease.leaseId);
      const context = reviewContext(), file = await workflowFile({ ...task.media, id: task.id }, readOnly, context);
      if (number !== generation.current) return;
      await openFile(file, task, false);
    } catch (cause) { setBusy(null); setRecoveryStatus(cause instanceof Error ? cause.message : '任务未能打开，原资料保留'); navigate('home'); }
  }
  async function preserveCurrent(discarded = false) {
    const current = activity.current, original = current.workspace;
    if (!original || !current.activeTask || !current.editing && !current.unsaved) return;
    const context = reviewContext();
    if (recoveryConflict) { const result = await archiveWorkspace(recoveryConflict, context); if (!result.archived) throw new Error('旧恢复副本归档未确认，先保留本页'); }
    const workspace = discarded ? { ...original, notes: original.baseNotes, dirty: false, newDraft: emptyDraft(), editDraft: emptyDraft(), parked: [], view: { kind: 'new' as const } } : original;
    await workspaceTail.current.catch(() => {});
    const outcomes = await Promise.allSettled([cacheWorkspace(service.dataId, workspace, context), current.editing && service.state === 'online' ? saveWorkspace(workspace, context) : Promise.reject(new Error('未确认本机恢复'))]);
    if (outcomes.every(item => item.status === 'rejected') || current.unsaved && !discarded && outcomes[1].status === 'rejected') throw new Error('恢复副本尚未回传到本机，先保留当前页面；未释放媒体或清空输入。');
  }
  async function releaseMedia(discarded = false, preserved = false) {
    if (!preserved) await preserveCurrent(discarded);
    player.current?.pause(); analysis.stop(); generation.current++; captureSequence.current++;
    await releaseClient().catch(() => {}); setReviewContext(null, null); setEditing(false); setMedia(null); setActiveTask(null);
    setNotes([]); setBaseNotes([]); setNewDraft(emptyDraft()); setEditDraft(emptyDraft()); setParked([]); setDirty(false); setBusy(null); setImages({}); setFrameIndexOpen(false); setCompareOpen(false); setRecoveryConflict(null); setRecoveryCompare(false); setRecordPath(null); setRecordError(''); invalidate(); navigate('home');
  }
  async function finishTask(discarded = false, confirmOthers = false) {
    const task = activity.current.activeTask; if (!task) return;
    try { await preserveCurrent(discarded); await changeTaskStatus(task.id, 'closed', confirmOthers); await releaseMedia(discarded, true); await tasks.refresh(); message.success('已结束这个任务的等待，意见和历史仍保留；其他任务不受影响。'); }
    catch (cause) {
      if (cause instanceof ReviewAPIError && cause.code === 'task_in_use') Modal.confirm({ title: '其他窗口也在使用这个任务', content: cause.message, okText: '仍结束此任务', cancelText: '先不结束', okButtonProps: { danger: true }, onOk: () => finishTask(discarded, true) });
      else setFeedback(cause instanceof Error ? cause.message : '结束任务未确认，当前输入保留');
    }
  }
  async function requestRestart() {
    if (recoveryAction.current || service.state !== 'online' || activity.current.busy) return;
    recoveryAction.current = true;
    try {
      const summary = await restartInfo();
      Modal.confirm({ title: '重启整个校对室的服务？', content: <><p>这会影响共用服务的 {summary.windows} 个窗口、{summary.pendingTasks} 项待校对任务，以及 {summary.analysis.running + summary.analysis.queued} 项运行或排队分析、{summary.uploads} 份上传。</p><p>{summary.unsavedWindows ? `${summary.unsavedWindows} 个窗口最近报告未保存输入。请先让各窗口保存；仍重启时只保留已确认恢复副本与各页当前输入，不代表已正式保存。` : '本页先回传恢复副本；意见和待校对任务保留，未完成分析会中断。'}</p><p>先准备Media Review本机重启入口，再退出旧服务。不刷新或关闭页面，不上传素材；只有真实连接检查通过才算恢复。端口变化时可能另开新入口，请保留旧页。</p></>, okText: summary.unsavedWindows ? '保留输入并重启服务' : '重启校对服务', cancelText: '先不重启', okButtonProps: { danger: true }, onCancel: () => { recoveryAction.current = false; }, onOk: async () => {
        try {
          await preserveCurrent();
          const result = await restartService(service.runtimeId, summary.impactRevision, summary.unsavedWindows > 0);
          if (!result.restarting) throw new Error('重启请求未确认，当前输入保留');
          setLaunchFeedback(''); setRecoveryWait({ kind: 'restart', runtimeId: service.runtimeId });
          window.dispatchEvent(new Event('review-restart'));
        } catch (cause) { recoveryAction.current = false; message.error(cause instanceof Error ? cause.message : '重启未确认，当前输入保留'); throw cause; }
      } });
    } catch (cause) { recoveryAction.current = false; message.error(cause instanceof Error ? cause.message : '重启影响未能核对，原服务未退出'); }
  }
  async function requestExit() {
    try {
      const summary = await serviceSummary();
      Modal.confirm({ title: '退出整个校对室？', content: <><p>当前有 {summary.pendingTasks} 项待校对、{summary.windows} 个窗口、{summary.analysis.running + summary.analysis.queued} 项排队或运行中的分析。</p><p>{summary.unsavedWindows ? `${summary.unsavedWindows} 个窗口最近报告有未保存输入。建议先在各窗口保存，或取消退出。` : '意见与已确认恢复副本保留；未完成分析会标为中断。'}</p><p>不会关闭浏览器或删除资料。真正退出后，可使用已配置的页面启动入口，或从桌面／启动文件重开；退出不会自动重启。</p></>, okText: summary.unsavedWindows ? '保留已确认副本并退出全局' : '退出整个校对室', cancelText: '取消退出', okButtonProps: { danger: true }, onOk: async () => {
        await preserveCurrent(); const result = await closeService(service.runtimeId, summary.unsavedWindows > 0);
        if (!result.closing) throw new Error('退出请求未确认'); message.info('已请求退出校对室；各窗口输入仍在，请不要把退出当作已保存。');
      } });
    } catch (cause) { message.error(cause instanceof Error ? cause.message : '退出未确认'); }
  }
  function perform(action: Action, discarded = false) {
    setFeedback(''); setReferenceOpen(false); setLoop(false); auditionEnd.current = null;
    if (action.type === 'file') { void openFile(action.file, action.task, true, action.newTask, action.readOnly); return; }
    if (action.type === 'task') { void openTask(action.task, action.readOnly); return; }
    if (action.type === 'suspend') { void releaseMedia().then(() => message.info('已挂起并释放媒体；任务仍在等待，手选素材下次需要重选。')).catch(cause => setFeedback(cause.message)); return; }
    if (action.type === 'end') { void finishTask(discarded); return; }
    if (action.type === 'exit') { void requestExit(); return; }
    if (action.type === 'finish') { void save(true); return; }
    if (action.type === 'detail') {
      setSelecting(null); setView({ kind: 'detail', id: action.note.id }); setEditDraft(emptyDraft());
      player.current?.pause(); const position = action.note.reference?.frameMs ?? action.note.startMs; if (position !== null) seek(position); return;
    }
    if (action.type === 'restore') {
      setView({ kind: 'new' }); setEditDraft(emptyDraft()); setSelecting(null);
      if (parked.length) {
        const [restored, ...rest] = parked; setParked(hasDraftWork(newDraft) ? [...rest, newDraft] : rest); setNewDraft(restored);
        const position = restored.frameMs ?? parseTime(restored.startText); if (position !== null) seek(position);
      }
      focusOpinion(); return;
    }
    setSelecting(null); setView({ kind: 'new' }); setEditDraft(emptyDraft());
    if (action.type === 'new') { regionHistory.clear(); setClearedMarks(null); setSelectedRegion(null); setNewDraft(emptyDraft()); focusOpinion(); return; }
    const value: ReviewDraft = { ...(!newDraft.mode && hasDraftWork(newDraft) ? newDraft : emptyDraft()), mode: action.mode, startText: action.mode === 'whole' ? '' : formatTime(action.cue?.startMs ?? action.position), endText: action.cue ? formatTime(action.cue.endMs) : '', frameMs: action.mode === 'frame' ? action.position : null };
    setNewDraft(value); setClearedMarks(null); invalidate();
    if (action.marker) return; // A start mark must not stop playback or move focus.
    setCurrentMs(action.position); player.current?.pause();
    if (action.mode === 'range') { gestureBackup.current = value; setSelecting(action.cue ? null : 'range'); if (action.cue) seek(action.cue.startMs); else root.current?.querySelector('.sound-panel')?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
    if (action.mode === 'frame') { setListenOnly(false); gestureBackup.current = value; setSelecting('frame'); void captureFrame(action.position, value); }
    if (action.mode !== 'frame') focusOpinion();
  }
  function request(action: Action) {
    if (busy) { message.info('当前操作尚未结束，请稍后再切换或提交；输入保留。'); return; }
    const leaving = ['file', 'task', 'end', 'exit', 'suspend'].includes(action.type);
    if (savingRef.current || locked && !leaving && action.type !== 'detail') return;
    if (action.type === 'suspend') { perform(action); return; }
    const boundNew = hasDraftWork(newDraft) && (newDraft.mode !== null || action.type === 'new');
    const shouldGuard = leaving ? unsaved : action.type === 'detail' || action.type === 'restore' ? editChanged : editChanged || boundNew;
    if (shouldGuard) { player.current?.pause(); setPending(action); return; }
    perform(action);
  }
  function requestTarget(mode: TargetMode, cue?: TranscriptCue) {
    if (locked || (mode === 'frame' && media?.isAudio)) return;
    if (!reading && (mode === 'whole' || mode === 'point' && draft.mode === 'whole')) {
      setSelecting(null); player.current?.pause();
      patch({ mode, startText: mode === 'whole' ? '' : formatTime(actualTime()), endText: '' });
      focusOpinion(); return;
    }
    if (!reading && draft.mode && mode === 'frame') { beginFrameSelection(); return; }
    if (!reading && draft.mode && mode === 'range') {
      gestureBackup.current = draft; player.current?.pause(); setSelecting('range');
      patch({ mode: 'range', ...(cue ? { startText: formatTime(cue.startMs), endText: formatTime(cue.endMs) } : {}) });
      if (cue) { setSelecting(null); gestureBackup.current = null; seek(cue.startMs); focusOpinion(); }
      return;
    }
    const position = actualTime(); player.current?.pause();
    request({ type: 'target', mode, position, cue });
  }
  function markRangeBoundary() {
    if (locked || service.state !== 'online') return;
    const position = actualTime();
    if (pendingRange) {
      if (position <= start!) { setFeedback('终点须晚于起点，请继续播放或向后定位。'); return; }
      patch({ endText: formatTime(position) }); setSelecting(null); gestureBackup.current = null;
      player.current?.pause(); focusOpinion(); return;
    }
    if (!reading && draft.mode) {
      patch({ mode: 'range', startText: formatTime(position), endText: '' });
      setSelecting(null); setLoop(false); gestureBackup.current = null; return;
    }
    request({ type: 'target', mode: 'range', position, marker: true });
  }
  function beginFrameSelection() {
    if (locked || media?.isAudio || reading) return;
    if (regions.length >= 50) { setFeedback('一帧最多标记50处，请将其余问题另存一条意见。'); return; }
    const position = regions.length && draft.frameMs !== null ? draft.frameMs : actualTime();
    player.current?.pause(); gestureBackup.current = draft;
    if (Math.abs(actualTime() - position) >= 80) seek(position);
    setListenOnly(false); setSelecting('frame');
    if (draft.frameMs === position && (draft.snapshot || draft.reference)) return;
    void captureFrame(position, draft, view.kind === 'edit');
  }
  function finishFrameSelection() {
    setSelecting(null); gestureBackup.current = null; focusOpinion();
  }
  function showNote(note: ReviewNote) { request({ type: 'detail', note }); }
  function discardCurrent() {
    if (view.kind === 'edit') setEditDraft(emptyDraft()); else setNewDraft(emptyDraft());
    setSelecting(null); captureSequence.current++; setCapturing(false); setFeedback(''); regionHistory.clear(); setClearedMarks(null);
  }

  async function save(finish = false, discardIncomplete = false, allDrafts = false, overrideRevision?: string | null): Promise<boolean> {
    if (!media || !durationMs || busy || savingRef.current || recordError || !editing || !activeTask) return false;
    if (service.state !== 'online') { setFeedback('服务尚未连接，不能确认保存。请保留本页，从桌面入口重开；当前草稿不清空。'); return false; }
    const number = generation.current, context = reviewContext();
    let drafts = finish || allDrafts ? [...(view.kind === 'edit' && editChanged ? [editDraft] : []), newDraft, ...parked].filter(hasDraftWork) : [view.kind === 'edit' ? editDraft : newDraft].filter(hasDraftWork);
    const unfinished = drafts.find(value => draftProblem(value, durationMs, value === draft && selectionBlocksSave));
    if (unfinished && !discardIncomplete) {
      if (finish) setPending({ type: 'finish' });
      else setFeedback(draftProblem(unfinished, durationMs, selectionBlocksSave));
      return false;
    }
    if (discardIncomplete) drafts = drafts.filter(value => !draftProblem(value, durationMs, value === draft && selectionBlocksSave));
    if (selecting === 'frame' && !capturing) { setSelecting(null); gestureBackup.current = null; }
    let attemptedNotes = notes;
    savingRef.current = true; setBusy('saving'); setFeedback(''); message.destroy();
    try {
      let updated = notes;
      for (const value of drafts) {
        let reference = value.reference;
        if (value.snapshot && value.frameMs !== null && !reference) reference = { ...await saveReference(media.identity.fingerprint, value.snapshot), frameMs: value.frameMs };
        const note = draftToNote({ ...value, reference }, durationMs);
        updated = sortedNotes([...updated.filter(item => item.id !== note.id), note]);
      }
      attemptedNotes = updated;
      const nextCompletion = finish ? { outcome: updated.length ? 'with-notes' as const : 'no-changes' as const, completedAt: new Date().toISOString() } : unsaved ? null : completion;
      const receipt = await saveRecord({ format: COMPLETE_FORMAT, media: media.identity, notes: updated, completion: nextCompletion }, overrideRevision === undefined ? recordRevision : overrideRevision, context);
      if (number !== generation.current) return false;
      const remainingDrafts = finish || allDrafts ? [] : view.kind === 'edit' && hasDraftWork(newDraft) ? [...parked, newDraft] : parked;
      const cleared: ReviewWorkspace = { format: 'media-review-workspace/v4', media: media.identity, currentMs: actualTime(), notes: receipt.record.notes, baseNotes: receipt.record.notes, dirty: false, newDraft: emptyDraft(), editDraft: emptyDraft(), parked: remainingDrafts, view: { kind: 'new' } };
      workspaceTail.current = workspaceTail.current.catch(() => {}).then(async () => {
        const outcomes = await Promise.allSettled([cacheWorkspace(service.dataId, cleared, context), saveWorkspace(cleared, context)]);
        if (outcomes.every(result => result.status === 'rejected')) setRecoveryStatus('正式意见已保存，但恢复副本清理未确认；请保留本页');
      });
      await workspaceTail.current;
      if (number !== generation.current) return false;
      activity.current = { ...activity.current, unsaved: remainingDrafts.some(hasDraftWork), workspace: cleared };
      setParked(remainingDrafts);
      setNotes(receipt.record.notes); setBaseNotes(receipt.record.notes); setRecordRevision(receipt.revision ?? null); setConflict(null); setRecordPath(receipt.recordPath); setDirty(false);
      setNewDraft(emptyDraft()); setEditDraft(emptyDraft()); setView({ kind: 'new' }); setSelecting(null); setSelectedRegion(null); setSaved(true);
      setCompletion(receipt.record.completion ?? null); regionHistory.clear(); setClearedMarks(null);
      setHandoff(null); setHandoffOpen(false);
      if (finish && receipt.revision) { try { const round = await createHandoffRound(activeTask.id, receipt.revision); setHandoff(createReviewHandoff({ ...receipt, recordPath: round.recordPath }, round)); setHandoffOpen(true); } catch (cause) { setFeedback('意见已保存，但固定交接未完成：' + (cause instanceof Error ? cause.message : '请重试完成审阅')); } } setCopied(false); setCopyError(''); setPending(null);
      if (!finish) { message.success('已保存到本机，可以继续写下一条。'); focusOpinion(); }
      return true;
    } catch (cause) {
      if (number === generation.current) {
        setFeedback(cause instanceof Error ? cause.message : '保存未确认，输入仍保留，可以重试。');
        if (cause instanceof ReviewAPIError && cause.code === 'edit_lease_lost') setEditing(false);
        if (cause instanceof ReviewAPIError && cause.code === 'review_conflict') {
          try { const latest = await loadRecord(media.identity.fingerprint, context); if (number === generation.current) setConflict({ latest, finish, allDrafts, proposed: attemptedNotes }); } catch { /* 读回失败时不改变基线或输入。 */ }
        }
      }
      return false;
    }
    finally { savingRef.current = false; if (number === generation.current) setBusy(null); }
  }
  async function resolvePending(saveFirst: boolean) {
    const action = pending; if (!action) return;
    if (action.type === 'finish') { if (saveFirst) return; await save(true, true); return; }
    const leaving = ['file', 'task', 'end', 'exit'].includes(action.type);
    if (saveFirst) { if (!await save(false, false, leaving)) return; }
    else {
      if (view.kind === 'edit' && hasDraftWork(newDraft) && (action.type === 'new' || action.type === 'target')) setParked(old => [...old, newDraft]);
      if (leaving) {
        try { await preserveCurrent(true); } catch (cause) { setFeedback(cause instanceof Error ? cause.message : '恢复状态未确认，当前输入保留'); return; }
        setNotes(baseNotes); setNewDraft(emptyDraft()); setEditDraft(emptyDraft()); setParked([]); setDirty(false);
      }
      else discardCurrent();
    }
    setPending(null);
    if (action.type === 'target') {
      const value: ReviewDraft = { ...emptyDraft(), mode: action.mode, startText: action.mode === 'whole' ? '' : formatTime(action.cue?.startMs ?? action.position), endText: action.cue ? formatTime(action.cue.endMs) : '', frameMs: action.mode === 'frame' ? action.position : null };
      setNewDraft(value); setView({ kind: 'new' }); setEditDraft(emptyDraft()); invalidate();
      if (action.marker) { setSelecting(null); return; }
      if (action.mode === 'frame') { setListenOnly(false); gestureBackup.current = value; setSelecting('frame'); void captureFrame(action.position, value); }
      else if (action.mode === 'range') { gestureBackup.current = value; setSelecting(action.cue ? null : 'range'); if (action.cue) seek(action.cue.startMs); }
      else setSelecting(null);
      focusOpinion();
    } else perform(action, !saveFirst);
  }
  async function copyHandoff() {
    if (!handoff || unsaved || busy || copying) return;
    const sequence = ++copySequence.current; setCopying(true); setCopyError('');
    try { await navigator.clipboard.writeText(handoff.text); if (sequence === copySequence.current) setCopied(true); }
    catch { if (sequence === copySequence.current) setCopyError('点击交接文字全选，按 Ctrl／⌘＋C 手动复制，再回聊天粘贴发送。意见已经保存，不用重写。'); }
    finally { if (sequence === copySequence.current) setCopying(false); }
  }
  function changeZoom(next: number) {
    const value = Math.max(1, Math.min(16, next));
    setZoom(value); setViewStart(Math.max(0, Math.min(durationMs - durationMs / value, currentMs - durationMs / value * .5)));
  }
  function playRange() {
    if (!selection || !player.current) return;
    seek(Math.max(0, selection.start - contextPad)); auditionEnd.current = loop ? null : Math.min(durationMs, selection.end + contextPad); void player.current.play().catch(() => setMediaError('当前选段暂不能播放。'));
  }
  useEffect(() => {
    const wave = root.current?.querySelector<HTMLElement>('.waveform');
    if (!wave || screen !== 'review' || !durationMs) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || selecting || locked) return;
      event.preventDefault();
      const bounds = wave.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
      const position = viewStart + span * fraction;
      const next = Math.max(1, Math.min(16, zoom * Math.exp(-event.deltaY * .002)));
      setZoom(next); setViewStart(Math.max(0, Math.min(durationMs - durationMs / next, position - durationMs / next * fraction)));
    };
    wave.addEventListener('wheel', wheel, { passive: false });
    return () => wave.removeEventListener('wheel', wheel);
  }, [screen, media?.url, durationMs, viewStart, span, zoom, selecting, locked]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (screen !== 'review' || pending || handoffOpen || referenceOpen || versionOpen || readinessOpen || tasksOpen || conflict || recoveryCompare || event.defaultPrevented) return;
      if (event.key === 'Escape' && selecting) { event.preventDefault(); cancelSelection(); return; }
      if ((event.target as HTMLElement)?.closest('input,textarea,.ant-modal,[contenteditable]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !reading) { event.preventDefault(); undoRegion(event.shiftKey); return; }
      if ((event.target as HTMLElement)?.closest('button,[role="slider"],[role="combobox"],[role="radio"]')) return;
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !locked && !reading) {
        if (event.key.toLowerCase() === 'i') { event.preventDefault(); if (pendingRange) patch({ startText: formatTime(actualTime()) }); else markRangeBoundary(); }
        if (event.key.toLowerCase() === 'o') { event.preventDefault(); if (pendingRange) markRangeBoundary(); else setFeedback('先按 I 或点击标记起点'); }
      }
      if (event.key === ',' || event.key === '.') { event.preventDefault(); player.current?.pause(); seek(actualTime() + (event.key === ',' ? -fineStep : fineStep)); }
      if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); nextIssue(); }
      if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(actualTime() + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? fineStep : 1000)); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });

  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (service.state !== 'online') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, probing = false;
    const probe = async () => {
      if (probing) return; probing = true; clearTimeout(timer);
      const current = activity.current, number = generation.current;
      try {
        const value = await heartbeat(current.activeTask?.id ?? null, current.unsaved);
        if (stopped || number !== generation.current) return;
        setPrimary(value.primary);
        if (!value.primary && !current.activeTask && !current.media && !requestedTask.current) initialPick.current = true;
        if (current.activeTask && value.taskStatus && value.taskStatus !== 'waiting') {
          setActiveTask(task => task ? { ...task, status: value.taskStatus! } : null); setEditing(false); setReviewContext(current.activeTask.id, null);
          setRecoveryStatus('这项任务已结束等待，本页输入仍保留；请在任务列表明确重开后再编辑。'); return;
        }
        if (current.activeTask && current.editing && !current.busy) {
          const lease = value.editing ? value : await claimEditing(current.activeTask);
          if (!stopped && number === generation.current) { setReviewContext(current.activeTask.id, lease.leaseId); setEditing(lease.editing); }
        }
      } catch { /* 连接状态统一由服务探测处理，不清空输入或伪造保存。 */ }
      finally { probing = false; if (!stopped) timer = setTimeout(probe, document.hidden ? 30_000 : 15_000); }
    };
    const wake = () => { if (!document.hidden) void probe(); };
    void probe(); window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [service.state, service.runtimeId, activeTask?.id]);
  useEffect(() => {
    const release = (event: PageTransitionEvent) => {
      if (event.persisted || !window.__REVIEW_SESSION_TOKEN__) return;
      void fetch('/api/clients/release', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Review-Token': window.__REVIEW_SESSION_TOKEN__ }, body: JSON.stringify({ clientId: REVIEW_CLIENT_ID }) }).catch(() => {});
    };
    window.addEventListener('pagehide', release); return () => window.removeEventListener('pagehide', release);
  }, []);
  useEffect(() => {
    if (initialPick.current || !requestedTask.current && !primary || !tasks.data || media || activeTask || busy || service.state !== 'online') return;
    initialPick.current = true;
    const requested = requestedTask.current;
    if (requested) void getTask(requested).then(({ task }) => { if (!activity.current.media && !activity.current.busy) void openTask(task); }).catch(cause => setRecoveryStatus(cause.message));
    else { const task = tasks.data.items.find(item => !item.manual && item.status === 'waiting'); if (task) void openTask(task); }
  }, [primary, tasks.data, service.state]);
  useEffect(() => {
    if (!activeTask || !media) return;
    const url = new URL(location.href); url.searchParams.set('task', activeTask.id);
    window.history.replaceState(window.history.state, '', url);
  }, [activeTask?.id, media?.url]);
  async function takeEditing() {
    if (!activeTask) return;
    Modal.confirm({ title: '明确接管这个任务的编辑？', content: '另一窗口会失去编辑权，但其输入仍保留。本页保存仍须核对正式意见版本，接管不会跳过冲突检查。', okText: '接管编辑', cancelText: '保持只读', onOk: async () => {
      const lease = await claimEditing(activeTask, true); setReviewContext(activeTask.id, lease.leaseId); setEditing(lease.editing);
      if (!activity.current.unsaved) setLoadAttempt(value => value + 1);
    } });
  }
  async function resolveRecovery(useOld: boolean) {
    if (!recoveryConflict || !editing || service.state !== 'online' || savingRef.current) return;
    savingRef.current = true; setBusy('loading');
    const number = generation.current;
    try {
      const result = await archiveWorkspace(recoveryConflict);
      if (!result.archived) throw new Error('旧副本未归档确认，两个版本仍保留');
      if (number !== generation.current) return;
      if (useOld) {
        setNotes(recoveryConflict.notes); setDirty(true); setNewDraft(recoveryConflict.newDraft); setEditDraft(recoveryConflict.editDraft); setParked(recoveryConflict.parked); setView(recoveryConflict.view);
        setCurrentMs(recoveryConflict.currentMs); if (player.current) player.current.currentTime = recoveryConflict.currentMs / 1000;
        invalidate();
      }
      setRecoveryConflict(null); setRecoveryCompare(false); setRecoveryStatus(useOld ? '已从旧副本继续编辑，尚未保存；原副本另存于drafts/archive。' : '继续使用正式意见；旧恢复副本已另存于drafts/archive。');
      return true;
    } catch (cause) { message.error(cause instanceof Error ? cause.message : '恢复选择未确认，两个版本保留'); }
    finally { savingRef.current = false; if (number === generation.current) setBusy(null); }
  }
  async function taskStatus(task: ReviewTask, status: 'waiting' | 'closed', confirmOthers = false) {
    if (task.id === activeTask?.id && status === 'closed') { request({ type: 'end' }); return; }
    try { await changeTaskStatus(task.id, status, confirmOthers); await tasks.refresh(); }
    catch (cause) {
      if (cause instanceof ReviewAPIError && cause.code === 'task_in_use') Modal.confirm({ title: '其他窗口也在使用这个任务', content: cause.message, okText: '仍结束此任务', cancelText: '先不结束', okButtonProps: { danger: true }, onOk: () => taskStatus(task, status, true) });
      else message.error(cause instanceof Error ? cause.message : '任务状态未更新');
    }
  }
  useEffect(() => {
    if (!media || !durationMs || !activeTask || busy || restoring.current || recordError || recoveryConflict || !service.dataId || !editing && !unsaved) return;
    const context = reviewContext();
    const workspace: ReviewWorkspace = { format: 'media-review-workspace/v4', media: media.identity, currentMs: actualTime(), notes, baseNotes, dirty, newDraft, editDraft, parked, view };
    let cancelled = false;
    setRecoveryStatus('正在保留恢复副本…');
    const timer = setTimeout(() => {
      workspaceTail.current = workspaceTail.current.catch(() => {}).then(async () => {
        await cacheWorkspace(service.dataId, workspace, context);
        if (!cancelled) setRecoveryStatus('浏览器恢复副本已保留，未替代正式保存');
        if (service.state === 'online' && editing) {
          await saveWorkspace(workspace, context);
          if (!cancelled) setRecoveryStatus('本机恢复副本已保留，未替代正式保存');
        }
      }).catch(() => { if (!cancelled) setRecoveryStatus('恢复副本未完全确认；请保留本页并尽快正式保存'); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [newDraft, editDraft, parked, view, notes, baseNotes, dirty, durationMs, media?.url, busy, playing, service.state, service.dataId, recordError, recoveryConflict, activeTask?.id, editing]);

  const reference = <div className="note-target">
    {targetImage ? <Button className="target-preview" type="text" aria-label="放大查看这条意见的参考画面" onClick={() => { player.current?.pause(); setReferenceOpen(true); }}>
      <span className="target-frame" style={{ width: Math.min(59, 77 * referenceAspect), height: Math.min(77, 59 / referenceAspect) }}><img src={targetImage} alt="这条意见的完整参考画面" /><FrameRegions regions={regions} selected={selectedRegion} /></span>
    </Button> : <div className="target-empty">{draft.mode === 'range' ? <ScissorOutlined /> : draft.mode === 'frame' ? <SelectOutlined /> : <ClockCircleOutlined />}</div>}
    <div className="target-text"><small>{draft.mode ? `本条意见 · ${MODE_LABEL[draft.mode]}` : '这条意见针对哪里？'}</small><strong>{draft.mode === 'whole' ? '整份作品' : draft.mode === 'range' ? `${draft.startText || '待选开始'} — ${draft.endText || '待选结束'}` : draft.startText || '先选一个位置'}</strong>
      <p>{draft.frameMs !== null ? `参考帧 ${formatTime(draft.frameMs)}` : reading && regions.length ? '旧记录未记录独立参考帧，未猜补截图' : '播放、点击台词不会改变意见目标'}</p>
      {targetTime !== null && <Button type="link" size="small" onClick={() => { player.current?.pause(); seek(targetTime); }}>返回标注位置</Button>}
      {!reading && draft.mode === 'range' && <Button type="link" size="small" disabled={locked || service.state !== 'online'} onClick={() => { gestureBackup.current = draft; setSelecting('range'); }}>调整这段时间</Button>}

    </div>
  </div>;
  const composition = <section className="opinion" aria-label="常驻意见栏">
    <div className="opinion-head"><h2>{reading ? '意见详情' : view.kind === 'edit' ? '修改这条意见' : '写下这条意见'}</h2><Tag>{reading ? KIND_LABEL[draft.kind] : view.kind === 'edit' ? '正在编辑' : '新意见'}</Tag></div>
    {(reading || !draft.mode) && <p className="opinion-instruction">{reading ? '已定位这条意见；查看不会覆盖你的新草稿。' : '先写想法也可以，再选位置。目标不会随播放变化。'}</p>}
    {!reading && !draft.mode && <Button className="whole-comment" size="small" disabled={locked} onClick={() => requestTarget('whole')}>整片意见 · 不限时间</Button>}
    {reference}{imageError && <p className="save-error" role="alert">{imageError}</p>}
    {!reading && (draft.mode || regions.length > 0 || clearedMarks) && <div className="marking-actions">
      <Button size="small" danger icon={<DeleteOutlined />} disabled={locked || !(draft.mode || regions.length || draft.reference || draft.snapshot)} onClick={() => clearMarks()}>清空本条全部标记</Button>
      {clearedMarks && <Button size="small" icon={<UndoOutlined />} disabled={locked} onClick={restoreClearedMarks}>恢复刚清空的标记</Button>}
      <small>{clearedMarks ? '标记已清空，意见文字保留。重新标记前可恢复。' : '保留意见文字'}</small>
    </div>}
    {reading ? <>{draft.text && <div className="note-read-text">{regions.length > 0 && <strong className="comment-heading">统一说明</strong>}{draft.text}</div>}
      {regions.length > 0 && <div className="region-comments" aria-label="各框意见">{regions.map(region => <div key={region.id} data-region-comment={region.id} className={selectedRegion === region.id ? 'is-active' : ''}><Button size="small" type={selectedRegion === region.id ? 'primary' : 'default'} onClick={() => { setSelectedRegion(region.id); if (draft.frameMs !== null) { player.current?.pause(); seek(draft.frameMs); } }}>框 {region.id}</Button><p>{region.text || (draft.text ? '沿用统一说明' : '未单独填写')}</p></div>)}</div>}
      {draft.topic && <p className="note-safe">问题类别：{TOPIC_LABEL[draft.topic]}</p>}
      <div className="note-footer"><Button type="primary" icon={<EditOutlined />} disabled={locked || service.state !== 'online'} onClick={() => { if (!selected) return; setEditDraft(fromNote(selected)); setView({ kind: 'edit', id: selected.id }); setFeedback(''); focusOpinion(); }}>修改这条意见</Button>
        {(hasDraftWork(newDraft) || parked.length > 0) && <Button onClick={() => request({ type: 'restore' })}>返回未保存草稿</Button>}</div></> : <Form layout="vertical" onFinish={() => void save()} disabled={locked}>
      <Form.Item className="kind-field" label="意见类型"><Segmented block aria-label="意见类型" value={draft.kind} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} onChange={value => patch({ kind: value as ReviewDraft['kind'] })} /></Form.Item>
      <details className="note-options"><summary>调整位置／问题类别</summary>{draft.mode && <Button className="whole-comment" size="small" type={draft.mode === 'whole' ? 'primary' : 'default'} onClick={() => requestTarget('whole')}>整片意见 · 不限时间</Button>}{draft.mode !== 'whole' && <div className="time-input-row"><Form.Item label={draft.mode === 'range' ? '开始时间' : '标注时间'}><Input aria-label="开始时间" value={draft.startText} placeholder="00:00.000" disabled={!draft.mode || draft.mode === 'frame' || locked} onChange={event => patch({ startText: event.target.value })} /></Form.Item>
        {draft.mode === 'range' && <Form.Item label="结束时间"><Input aria-label="结束时间" value={draft.endText} placeholder="00:00.000" onChange={event => patch({ endText: event.target.value })} /></Form.Item>}</div>}
      {draft.mode === 'range' && <div className="capture-row"><Button type="link" size="small" onClick={() => patch({ startText: formatTime(actualTime()) })}>设当前为开始</Button><Button type="link" size="small" onClick={() => patch({ endText: formatTime(actualTime()) })}>设当前为结束</Button></div>}
      <Form.Item label="问题类别（可选）"><Select aria-label="问题类别" allowClear value={draft.topic ?? undefined} placeholder="画面、字幕、声音、节奏…" options={Object.entries(TOPIC_LABEL).filter(([key]) => !media?.isAudio || key !== 'visual').map(([value, label]) => ({ value, label }))} onChange={value => patch({ topic: (value ?? null) as ReviewTopic | null })} /></Form.Item></details>
      <Form.Item label={commentRegion ? `框 ${commentRegion.id} 的意见` : regions.length ? '统一说明' : '你的意见'} htmlFor="opinion-text">
        {regions.length > 0 && <>
          <div className="opinion-scopes" role="group" aria-label="选择意见填写对象">
            <Button size="small" type={!commentRegion ? 'primary' : 'default'} aria-pressed={!commentRegion} onClick={() => { setSelectedRegion(null); focusOpinion(); }}><span>统一说明{draft.text.trim() && <span className="comment-filled" title="已有文字" aria-label="已有文字" />}</span></Button>
            {regions.map(region => <span className={`region-chip${commentRegion?.id === region.id ? ' is-active' : ''}`} key={region.id}>
              <Button size="small" type="text" aria-pressed={commentRegion?.id === region.id} onClick={() => { setSelectedRegion(region.id); if (draft.frameMs !== null && !atReference) { player.current?.pause(); seek(draft.frameMs); } focusOpinion(); }}><span>框 {region.id}{region.text?.trim() && <span className="comment-filled" title="已有文字" aria-label="已有文字" />}</span></Button>
              <Button size="small" type="text" danger icon={<CloseOutlined />} aria-label={`删除框 ${region.id}`} title={`删除框 ${region.id}`} onClick={() => { patch({ regions: regions.filter(item => item.id !== region.id) }); if (selectedRegion === region.id) setSelectedRegion(null); }} />
            </span>)}
          </div>
          <p id="opinion-scope-hint" className="opinion-scope-hint">统一说明适用于本条所有标记；不同问题可选框号分别写。任选一处填写即可保存。</p>
        </>}
        <Input.TextArea id="opinion-text" aria-label={commentRegion ? `框 ${commentRegion.id} 的意见` : regions.length ? '统一说明' : '你的意见'} aria-describedby={regions.length ? 'opinion-scope-hint' : undefined} value={commentRegion ? commentRegion.text ?? '' : draft.text} maxLength={2000} autoSize={{ minRows: regions.length ? 2 : 3, maxRows: 7 }} placeholder={commentRegion ? `框 ${commentRegion.id} 这里有什么问题，希望怎么改？` : '这段画面、声音、字幕或节奏，希望怎么改？'} onChange={event => commentRegion ? patch({ regions: regions.map(region => region.id === commentRegion.id ? { ...region, text: event.target.value } : region) }, false) : patch({ text: event.target.value })} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void save(); } }} />
      </Form.Item>
      <Button className="save-note" block type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy === 'saving'} disabled={locked || service.state !== 'online' || !!problem}>{selecting === 'frame' ? '完成框选并保存整条意见' : view.kind === 'edit' ? '保存这条修改' : '保存整条意见'}</Button>
      <p className="note-safe" role="status">{service.state !== 'online' ? '连接不可用，当前无法保存。输入仍在本页，请按上方提示重新打开校对室。' : !editing ? '本窗口只读；明确取得编辑权后才能保存，当前输入仍保留。' : problem || '可保存；写入并回读确认后，进入空白新意见。'}</p>
      {view.kind === 'edit' && <Button type="link" disabled={locked || service.state !== 'online'} onClick={() => selected && request({ type: 'detail', note: selected })}>取消编辑，查看原意见</Button>}
    </Form>}
    {!reading && (regions.length > 0 || regionHistory.canUndo || regionHistory.canRedo) && <div className="region-edit-tools" aria-label="画面框操作">
      <div className="region-history"><Button size="small" icon={<UndoOutlined />} disabled={locked || !regionHistory.canUndo} onClick={() => undoRegion()}>撤回上一步框选</Button><Button size="small" icon={<RedoOutlined />} disabled={locked || !regionHistory.canRedo} onClick={() => undoRegion(true)}>恢复上一步框选</Button></div>
      <small>只撤回或恢复画面框的新增、移动和删除；时间、意见文字不变。</small>
    </div>}
    {reading && selected && <RepairPanel note={selected} bundle={progress.bundle} disabled={locked || dirty} onRefresh={progress.refresh} onOpen={task => request({type:'task',task,readOnly:task.status !== 'waiting'})} />}
    {regions.length > 0 && <details className="coordinate-details"><summary>画面区域 · {regions.length} 处</summary>
      {regions.map(region => <div className="region-coordinate" key={region.id}><strong>区域 {region.id}</strong><div className="coordinate-fields">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{['横向', '纵向', '宽', '高'][index]}<Input aria-label={'区域' + region.id + '画面' + key} value={(region.rect[key] * 100).toFixed(1)} suffix="%" readOnly={reading || locked} onChange={event => {
        const value = Number(event.target.value) / 100; if (!Number.isFinite(value)) return;
        const next: Rect = { ...region.rect, [key]: Math.min(key === 'x' || key === 'y' ? .98 : 1, clamp01(value)) }; next.width = Math.min(Math.max(.02, next.width), 1 - next.x); next.height = Math.min(Math.max(.02, next.height), 1 - next.y);
        patch({ regions: regions.map(item => item.id === region.id ? { ...item, rect: next } : item) });
      }} /></label>)}</div></div>)}
    </details>}
    {feedback && <p className="save-error" role="alert">{feedback}</p>}
  </section>;

  const pendingDrafts = ['file', 'task', 'end', 'exit'].includes(pending?.type ?? '') ? [...(editChanged ? [editDraft] : []), newDraft, ...parked] : [view.kind === 'edit' ? editDraft : newDraft];
  const pendingProblem = pendingDrafts.filter(hasDraftWork).map(value => draftProblem(value, durationMs, selectionBlocksSave)).find(Boolean) ?? '';
  const taskPanel = <ReviewTasks data={tasks.data} error={tasks.error} currentId={activeTask?.id ?? null} page={tasks.page} includeClosed={tasks.closed} query={tasks.query} onQuery={tasks.setQuery} online={service.state === 'online'} filter={tasks.filter} sort={tasks.sort} onFilter={tasks.setFilter} onSort={tasks.setSort} onPage={tasks.setPage} onClosed={tasks.setClosed} onRefresh={() => void tasks.refresh()} onOpen={task => request({ type: 'task', task })} onSelectFile={task => chooseFile(undefined, task)} onNew={() => chooseFile(undefined, null, true)} onStatus={(task, status) => void taskStatus(task, status)} />;
  const otherTasks = Math.max(0, (tasks.data?.active ?? 0) - (activeTask?.status === 'waiting' ? 1 : 0));
  const app = <div className="review-app scheme-a" ref={root} data-ui-revision="review-0-3-0-beta-8">
    <header className="brandbar"><div className="brand"><img src="/brand/review-mark.svg" alt="Media Review" /><strong>Media Review</strong><span className="tool-name">音视频校对</span></div>
      <div className="brand-actions"><Button onClick={() => setReadinessOpen(true)}>本机可用性</Button>{activeTask && <Button onClick={() => setVersionOpen(true)}>版本与返修 · V{activeTask.version?.number ?? 1}</Button>}<span className="service-status-actions"><ServiceBadge state={service.state} />{service.state !== 'online' && service.state !== 'connecting' && <ServiceRecoveryButton compact state={service.state} launcher={launcher} waiting={!!recoveryWait} onStart={requestNativeStart} />}</span><Badge count={tasks.data?.active ?? 0} color="#a76543"><Button onClick={() => setTasksOpen(true)}>校对任务</Button></Badge><Dropdown trigger={['click']} menu={{ items: [...(media ? [{ key: 'suspend', label: '挂起当前任务 · 释放媒体' }, { key: 'end', label: '结束当前任务 · 保留历史' }, { type: 'divider' as const }] : []), { key: 'restart', label: '重启校对服务', disabled: service.state !== 'online' || !!recoveryWait || !!busy }, { key: 'exit', label: '退出整个校对室', danger: true }], onClick: ({ key }) => { if (key === 'suspend') request({ type: 'suspend' }); else if (key === 'end') request({ type: 'end' }); else if (key === 'restart') void requestRestart(); else request({ type: 'exit' }); } }}><Button disabled={busy === 'saving'}>任务操作</Button></Dropdown><span className="privacy"><SafetyCertificateOutlined />素材留在本机</span>{media && <><span className="save-indicator" role="status">{stateLabel}</span><Button icon={screen === 'home' ? <ArrowLeftOutlined /> : <HomeOutlined />} disabled={busy === 'saving'} onClick={() => navigate(screen === 'home' ? 'review' : 'home')}>{screen === 'home' ? '返回当前素材' : '回到主页'}</Button></>}<Button icon={<FolderOpenOutlined />} disabled={busy === 'saving'} onClick={() => chooseFile()}>打开其他素材</Button>{media && <Button className="save-button" icon={<SaveOutlined />} disabled={locked || service.state !== 'online'} loading={busy === 'saving'} onClick={() => void save()}>保存进度</Button>}{media && <Button type="primary" icon={<CommentOutlined />} loading={busy === 'saving'} disabled={locked || service.state !== 'online'} onClick={() => void save(true)}>{!notes.length && !hasDraftWork(newDraft) && !editChanged && !parked.some(hasDraftWork) ? '审阅完毕，没有意见' : '完成审阅并交接'}</Button>}</div>
      <input ref={fileInput} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { const task = chosenManualTask.current, newTask = chosenNewTask.current, readOnly = chosenReadOnly.current; chosenManualTask.current = null; chosenNewTask.current = false; chosenReadOnly.current = false; request({ type: 'file', file, newTask, readOnly, ...(task ? { task } : {}) }); } }} />
    </header>
    <ServiceNotice state={service.state} launcher={launcher} waiting={!!recoveryWait} onStart={requestNativeStart} />
    {launchFeedback && <Alert className="service-notice" type="warning" showIcon title="尚未确认恢复连接" description={launchFeedback} closable onClose={() => setLaunchFeedback('')} />}
    {!primary && !media && !requestedTask.current && tasks.data && tasks.data.active > 0 && <Alert className="service-notice" type="info" showIcon title="已有校对室主窗口，本页不自动重复加载视频" description="任务已经登记。需要手动对照时，从任务列表选择；同一任务须明确接管才可编辑。" />}
    {media && activeTask && <div className="task-context" data-active-task={activeTask.id}><Tag color={editing ? 'processing' : 'warning'}>{editing ? '本窗口可编辑' : '只读 · 不重复分析'}</Tag><strong>{activeTask.title}</strong><span>{activeTask.label || (activeTask.manual ? '手选任务' : 'Agent 送片')} · {activeTask.id.slice(0, 8)}</span>{!editing && <Button size="small" onClick={() => void takeEditing()}>明确接管编辑</Button>}{activeTask.legacy && <small>沿用旧版资料；旧记录只有抽样身份，请核对是否同一版本。</small>}{otherTasks > 0 && <Button size="small" type="link" onClick={() => setTasksOpen(true)}>另有 {otherTasks} 项待校对</Button>}{completion && !unsaved && <Tag color="success">{completion.outcome === 'no-changes' ? '本轮已审阅 · 没有意见' : '本轮审阅已完成'}</Tag>}</div>}
    {screen === 'home' && !media && recoveryStatus && <Alert className="service-notice" type="warning" showIcon title={recoveryStatus} />}
    {screen === 'home' && <ReviewHome hasMedia={!!media} online={service.state === 'online'} onOpen={chooseFile} onResume={() => navigate('review')} tasks={taskPanel} />}
    <Drawer title="校对任务与分析队列" open={tasksOpen} size={560} onClose={() => setTasksOpen(false)} className="task-drawer">{taskPanel}</Drawer>
    {media && <main className={`workspace-wrap ${listenOnly ? 'audio-view' : ''}`} style={{ display: screen === 'review' ? undefined : 'none' }}>
      <div className="project-row"><div className="project-name"><span className="media-kind">{media.isAudio ? <AudioOutlined /> : <VideoCameraOutlined />}</span><div><h1 title={media.file.name}>{media.file.name}</h1><small>{media.isAudio ? '本机录音' : `${media.width} × ${media.height} · 完整画面`} · {formatTime(durationMs, false)} · 时间从0开始</small></div></div><div className="step-line"><span><b>01</b>打开素材</span><span className="on"><b>02</b>找到位置</span><span><b>03</b>写意见并交接</span></div></div>
      {recordError && <Alert type="error" showIcon title={activeTask ? '已有意见未能读取，原记录保留' : '任务尚未登记，本页文件保留'} description={recordError} action={<Button onClick={() => setLoadAttempt(value => value + 1)}>重试读取</Button>} />}
      <div className="workspace"><section className="review-main" aria-label="媒体审阅区">
        <section ref={videoSurface} className={`surface${presentation.expanded ? ' is-expanded' : ''}`} data-lenis-prevent={presentation.expanded || presentation.fullscreen ? '' : undefined} aria-label={presentation.expanded || presentation.fullscreen ? '放大的视频播放器' : '播放器'}><div className="surface-tools"><span className="surface-label" title={media.file.name}>{presentation.expanded || presentation.fullscreen ? media.file.name : '定位问题'}</span><div className="surface-actions">
          {selecting === 'frame' ? <><Button className="finish-frame" type="primary" icon={<CheckOutlined />} disabled={locked} onClick={finishFrameSelection}>完成框选</Button><Button danger className="cancel-frame" disabled={busy === 'saving'} icon={<CloseOutlined />} onClick={cancelSelection}>取消本次框选</Button><span className="frame-selection-count">已标 {regions.length} 处 · 可连续画框</span></> : <>
            <Button disabled={locked || service.state !== 'online'} icon={<ClockCircleOutlined />} onClick={() => requestTarget('point')}>标记时间点</Button>
            <Button type={pendingRange ? 'primary' : 'default'} disabled={locked || service.state !== 'online'} icon={<ScissorOutlined />} onClick={markRangeBoundary}>{pendingRange ? '标记终点' : !reading && draft.mode === 'range' ? '重标起点' : '标记起点'}</Button>
            {!reading && (draft.mode === 'range' || draft.mode === 'point') && <Button danger className="clear-time" icon={<CloseOutlined />} disabled={locked} onClick={() => clearMarks(true)}>{draft.mode === 'range' ? '清空时间段' : '清空时间点'}</Button>}
            {!media.isAudio && <Button disabled={locked || service.state !== 'online'} icon={<SelectOutlined />} onClick={() => requestTarget('frame')}>{regions.length && !reading ? '继续框选同一帧' : '框选当前画面'}</Button>}
            {selecting === 'range' && <Button danger className="clear-time" disabled={busy === 'saving'} icon={<CloseOutlined />} onClick={cancelSelection}>取消本次选段</Button>}
          </>}
        </div></div>
          <div ref={stage} className={`viewer ${listenOnly ? 'audio-mode' : ''} ${media.width / media.height > 1 ? 'landscape' : ''}`}>
            {media.isAudio ? <audio ref={player as React.RefObject<HTMLAudioElement>} data-primary-media src={media.url} preload="metadata" onLoadedMetadata={metadata} onDurationChange={metadata} onTimeUpdate={onTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setMediaError('浏览器无法播放此音频，请检查编码或换用可播放文件。'); setBusy(null); analysis.stop(); }} /> : <div className="video-holder" style={{ width: frameSize.width, height: frameSize.height, visibility: listenOnly ? 'hidden' : undefined }}>
              <video ref={player as React.RefObject<HTMLVideoElement>} data-primary-media src={media.url} playsInline preload="metadata" aria-label="当前原始视频" onLoadedMetadata={metadata} onDurationChange={metadata} onTimeUpdate={onTimeUpdate} onPlay={() => { setPlaying(true); setSelecting(null); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setMediaError('浏览器无法播放此视频，请检查编码或换用MP4。'); setBusy(null); analysis.stop(); }} />
              <VideoPreview videoRef={player} sourceKey={media.url} active={screen === 'review' && !listenOnly} />
              {!playing && !listenOnly && reading && atReference && regions.length > 0 && <div className="frame-layer readonly"><FrameRegions regions={regions} selected={selectedRegion} onSelect={focusRegion} /></div>}
              {!playing && !listenOnly && !reading && !locked && !capturing && (selecting === 'frame' || (atReference && regions.length > 0)) && <FrameCanvas key={view.kind + '-' + (draft.id ?? 'new') + '-' + draft.frameMs} regions={regions} regionSerial={draft.regionSerial ?? 0} selected={selectedRegion} onSelect={focusRegion} drawing={selecting === 'frame'} onChange={value => patch({ regions: value })} onDone={region => patch({ regions: [...regions, region] })} />}
              {selecting === 'frame' && <span className="draw-hint">拖出多个框；写好意见后可直接保存</span>}
            </div>}
            {listenOnly ? <div className="audio-face"><div className="audio-title"><AudioOutlined />听原声，按位置留下意见</div><div className="audio-large-clock">{formatTime(currentMs, false)}<small>.{String(currentMs % 1000).padStart(3, '0')}</small></div><p className="audio-caption">{activeCue?.text ?? '点击右侧一句台词，或在下方时间轴上找到位置。'}</p><div className="audio-mini"><InfoCircleOutlined />播放位置只描述正在听哪里，不会改变意见目标。</div></div> : <><div className="viewer-side"><span>正在看的位置</span><strong>{formatTime(currentMs)}</strong><span>框选会暂停在此刻</span></div><div className="viewer-hint"><InfoCircleOutlined />继续播放时旧框会隐藏，参考画面仍留在意见旁。</div></>}
            {mediaError && <div className="media-error" role="alert">{mediaError}</div>}
          </div>
          <div className="transport"><Button className="transport-play" aria-label={playing ? '暂停' : '播放'} icon={playing ? <PauseOutlined /> : <PlayCircleOutlined />} disabled={!durationMs || capturing} onClick={() => void togglePlay()} /><strong className="clock">{formatTime(currentMs)}</strong><small>/ {formatTime(durationMs, false)}</small><Slider className="media-seek" ariaLabelForHandle="播放位置" min={0} max={Math.max(1, durationMs)} step={10} value={currentMs} onChange={seek} tooltip={{ formatter: value => formatTime(value ?? 0) }} disabled={!durationMs || capturing} /><Select className="speed-select" size="small" aria-label="播放速度" getPopupContainer={node => node.parentElement!} value={rate} options={[.5, .75, 1, 1.25, 1.5, 2].map(value => ({ value, label: `${value}×` }))} onChange={value => { setRate(value); if (player.current) player.current.playbackRate = value; }} />{!media.isAudio && !listenOnly && <div className="video-view-actions"><Button data-player-resize aria-label={presentation.expanded || presentation.fullscreen ? '收起视频画面' : '放大视频画面'} aria-pressed={presentation.expanded} icon={presentation.expanded || presentation.fullscreen ? <ShrinkOutlined aria-hidden /> : <ExpandAltOutlined aria-hidden />} disabled={presentation.pending} onClick={presentation.toggleExpanded}>{presentation.expanded || presentation.fullscreen ? '收起' : '放大'}</Button><Button aria-label={presentation.fullscreen ? '退出视频全屏' : '视频全屏'} aria-pressed={presentation.fullscreen} icon={presentation.fullscreen ? <FullscreenExitOutlined aria-hidden /> : <FullscreenOutlined aria-hidden />} loading={presentation.pending} onClick={() => void presentation.toggleFullscreen()}>{presentation.fullscreen ? '退出全屏' : '全屏'}</Button></div>}</div>
        </section>
        <section className="sound-panel" aria-label="时间定位与选段"><div className="sound-head"><div className="sound-title"><AudioOutlined /><strong>波形与时间轴</strong><small>画面、声音共用时间范围</small></div><div className="sound-actions"><Button icon={<ScissorOutlined />} disabled={locked || service.state !== 'online'} onClick={() => requestTarget('range')}>拖选时间段</Button><label className="contrast"><Switch size="small" checked={contrast} onChange={setContrast} aria-label="增强强弱对比" />强弱增强</label></div></div>
          <div className="timeline-tools"><Button size="small" aria-label="时间轴向前" disabled={zoom === 1} onClick={() => setViewStart(Math.max(0, viewStart - span * .7))}>←</Button><Button size="small" aria-label="时间轴向后" disabled={zoom === 1} onClick={() => setViewStart(Math.min(durationMs - span, viewStart + span * .7))}>→</Button><Button size="small" aria-label="缩小时间轴" disabled={zoom === 1} onClick={() => changeZoom(zoom / 1.5)}>−</Button><Button size="small" aria-label="放大时间轴" disabled={zoom === 16} onClick={() => changeZoom(zoom * 1.5)}>＋</Button><Button size="small" disabled={zoom === 1} onClick={() => changeZoom(1)}>全览</Button><span>{zoom.toFixed(1)}×</span>{selecting === 'range' && <Button size="small" onClick={cancelSelection}>取消选段</Button>}</div>
          {screen === 'review' && <ReviewWaveform peaks={analysis.peaks} durationMs={durationMs} currentMs={currentMs} viewStartMs={viewStart} viewEndMs={viewEnd} selection={selection ?? (pendingRange && currentMs > start! ? { start: start!, end: currentMs } : null)} pendingStart={pendingRange ? start : null} selecting={selecting === 'range'} disabled={!durationMs || !!busy || capturing} large={listenOnly} contrast={contrast} notes={ordered} onSeek={seek} onNote={showNote} onRangeChange={(begin, finish) => { player.current?.pause(); patch({ mode: 'range', startText: formatTime(begin), endText: formatTime(finish) }); }} onRangeDone={() => { setSelecting(null); gestureBackup.current = null; focusOpinion(); }} onRangeCancel={cancelSelection} />}
          <div className="sound-foot"><span>{formatTime(viewStart, false)}</span><span>{selecting === 'range' ? '在时间轴上拖选起止' : selection ? `${formatTime(selection.start)} — ${formatTime(selection.end)}` : pendingRange ? '起点已记录：继续播放，到问题结束时点“标记终点”' : '边看边标起点、终点，也可以拖选时间段'}</span><span>{formatTime(viewEnd, false)}</span></div>
          <details className="fine-position"><summary>快捷键与精细定位</summary><p>I 起点 · O 终点 · 空格播放/暂停 · ←/→ 一秒 · Shift+←/→ 或 ,/. 细步 · N 下一条问题。细步为时间定位，精确剪点仍须回源核对。</p><div className="product-actions"><Select size="small" aria-label="细步时长" value={fineStep} onChange={setFineStep} options={[{value:10,label:'10 毫秒'},{value:40,label:'40 毫秒'},{value:100,label:'100 毫秒'}]} /><Button size="small" onClick={() => { player.current?.pause(); seek(actualTime()-fineStep); }}>向前细步</Button><Button size="small" onClick={() => { player.current?.pause(); seek(actualTime()+fineStep); }}>向后细步</Button></div></details><div className="wave-bottom"><span>{analysis.peaks.length ? '真实RMS · 整段统一标尺 · 不改变音量' : analysis.waveError || (analysis.running ? '正在本机计算波形，仍可按时间标记。' : '波形暂不可用，仍可按时间标记。')}</span>{selection && <><Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={playRange}>回放选段</Button><Select size="small" aria-label="回放前后上下文" value={contextPad} onChange={setContextPad} options={[{value:0,label:'仅选段'},{value:500,label:'前后 0.5 秒'},{value:1000,label:'前后 1 秒'},{value:2000,label:'前后 2 秒'}]} /><label><Switch size="small" checked={loop} onChange={setLoop} />循环</label></>}</div>
          <div className="player-options"><label><Button type="text" size="small" icon={<SoundOutlined />} aria-label={volume ? '静音' : '取消静音'} onClick={() => { if (volume) { oldVolume.current = volume; setVolume(0); } else setVolume(oldVolume.current || 75); }} /><Slider ariaLabelForHandle="音量" min={0} max={100} value={volume} onChange={setVolume} /><span>{volume}%</span></label>{!media.isAudio && <label><Switch size="small" checked={listenOnly} onChange={value => { setListenOnly(value); cancelSelection(); }} />只听声音</label>}</div>
          <WaveData peaks={analysis.peaks} durationMs={durationMs} />
        </section>
        {!media.isAudio && <details className="frame-disclosure" onToggle={event => setFrameIndexOpen(event.currentTarget.open)}><summary>画面索引 · 展开后按需生成</summary>{frameIndexOpen && screen === 'review' && visible && <FrameStrip url={media.url} durationMs={durationMs} currentMs={currentMs} onSeek={seek} viewStartMs={viewStart} viewEndMs={viewEnd} />}</details>}
        {listenOnly && <details className="compare-disclosure" onToggle={event => setCompareOpen(event.currentTarget.open)}><summary>对照另一版声音 · 收起可释放对照文件</summary>{compareOpen && screen === 'review' && <AudioCompare sourceUrl={media.url} sourceDurationMs={durationMs} currentMs={currentMs} sourcePlaying={playing} sourceName={media.file.name} onPauseSource={() => player.current?.pause()} onSeekSource={seek} />}</details>}
      </section><aside className="side-column" aria-label="意见与台词">
        {composition}
        <section className="preview-list" aria-label="意见清单"><header><strong>意见清单</strong><span className="list-count"><small>整片意见在前</small><output>{notes.length}</output></span></header><p className="list-instruction">点击查看完整意见，并回到对应时间和画面。</p><div className="note-filters"><Input.Search aria-label="搜索意见" placeholder="搜索意见与返修说明" allowClear value={noteQuery} onChange={event => setNoteQuery(event.target.value)} /><Select aria-label="筛选意见类别" value={topicFilter} onChange={setTopicFilter} options={[{value:'',label:'全部类别'},...Object.entries(TOPIC_LABEL).map(([value,label])=>({value,label}))]} /><Select aria-label="筛选处理进度" value={progressFilter} onChange={setProgressFilter} options={[{value:'',label:'全部进度'},...Object.entries(STATUS_LABEL).map(([value,label])=>({value,label}))]} /><Button size="small" disabled={!ordered.length} onClick={nextIssue}>下一条问题（N）</Button></div>{progress.error && <p role="alert">{progress.error}</p>}<div className="list-create"><Button icon={<PlusOutlined />} disabled={locked || service.state !== 'online'} onClick={() => request({ type: 'new' })}>新建意见</Button>{parked.length > 0 && <Button size="small" onClick={() => request({ type: 'restore' })}>恢复未保存草稿（{parked.length}）</Button>}</div>
          {ordered.length ? <ol data-lenis-prevent>{ordered.map((note, index) => <li key={note.id} data-review-id={note.id}><Button className={`review-item ${view.kind !== 'new' && note.id === view.id ? 'current' : ''}`} type="text" disabled={!!busy} onClick={() => showNote(note)} onKeyDown={event => {
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const buttons = root.current?.querySelectorAll<HTMLButtonElement>('.review-item'); if (!buttons?.length) return; buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))].focus(); }
          }}><span className="review-number">{String(index + 1).padStart(2, '0')}</span><span className="review-item-copy"><span className="review-item-meta"><strong>{note.scope === 'whole' ? '整片意见' : formatTime(note.startMs!)}{note.endMs !== null ? ` — ${formatTime(note.endMs)}` : ''}</strong><span>{KIND_LABEL[note.kind]} · {STATUS_LABEL[progress.bundle?.statuses[note.id]?.status ?? (note.kind === 'discuss' ? 'clarify' : 'pending')]}</span></span><span className="review-item-text">{note.text}</span></span></Button></li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={recordError ? '记录未读回，不代表没有意见' : '保存后的意见会出现在这里'} />}
          <div className="list-foot">{deletedNotes.length > 0 ? <Button type="link" size="small" disabled={locked} onClick={undoNoteDeletion}>撤销删除意见</Button> : <span>清单较多时可在这里滚动</span>}{selected && <Popconfirm title="移除这条意见？" description="保存后才更新本机记录，原媒体不变。" okText="移除" cancelText="取消" onConfirm={() => removeNote(selected)}><Button type="text" danger size="small" icon={<DeleteOutlined />} disabled={locked || service.state !== 'online'}>移除所选</Button></Popconfirm>}</div>
        </section>
        <section className="transcript"><header className="transcript-head"><strong>按句找位置</strong><span>点击整句可跳转</span></header><TranscriptPanel taskId={activeTask?.id} onImportedCues={setImportedCues} disabled={locked || service.state !== 'online'} mediaKey={media.url} cues={analysis.cues} status={analysis.status} error={analysis.error} progress={analysis.progress} elapsedMs={analysis.elapsedMs} onCancel={analysis.stop} onRetry={analysis.retry} currentMs={currentMs} durationMs={durationMs} onSeek={seek} onMark={cue => requestTarget('range', cue)} /></section>
        {handoff && !unsaved && <Button icon={<CommentOutlined />} onClick={() => setHandoffOpen(true)}>查看已保存的交接内容</Button>}
        {(notes.length > 0 || completion) && <Button loading={exporting} disabled={unsaved || !!busy || service.state !== 'online'} onClick={async () => {
          setExporting(true);
          try { const result = await exportRecord(media.identity.fingerprint); if (!result.exported) throw new Error('导出未确认'); setExportPath(result.directory); }
          catch (cause) { message.error(cause instanceof Error ? cause.message : '导出未完成，原意见保留'); }
          finally { setExporting(false); }
        }}>导出返修资料包</Button>}
        {recordPath && <details className="record-actions"><summary>查看本机意见记录位置</summary><p>{recordPath}</p></details>}
      </aside></div>
      <div className="recovery-status" role="status">{recoveryStatus}{recoveryConflict && <Button type="link" size="small" onClick={() => setRecoveryCompare(true)}>比对旧恢复副本</Button>}</div>
      <div className="bottom-hint"><span>空格播放／暂停 · ← →定位 · Esc取消本次选取 · 非输入框内 Ctrl／⌘＋Z 撤回画面框操作 · Ctrl／⌘＋Enter保存意见</span><span>原素材只读 · 精确剪点回源核对</span></div><p className="font-credit"><a href="/licenses/MiSans-License.pdf" target="_blank" rel="noopener">本页使用 MiSans · © Xiaomi</a></p>
    </main>}
    <Drawer title="本机可用性与版本" open={readinessOpen} onClose={() => setReadinessOpen(false)} size={560} destroyOnHidden><ReadinessPanel /></Drawer>
    <Drawer title="作品版本与返修复核" open={versionOpen} onClose={() => setVersionOpen(false)} size={720} destroyOnHidden>{activeTask && <VersionPanel task={activeTask} editable={editing && !unsaved} onOpen={task => { setVersionOpen(false); request({type:'task',task,readOnly:task.status !== 'waiting'}); }} onNew={() => { setVersionOpen(false); chooseFile(undefined,null,true,false,activeTask.id); }} onSeek={ms => { setVersionOpen(false); player.current?.pause(); seek(ms); }} />}</Drawer>
    <Modal centered open={recoveryCompare && !!recoveryConflict} title="正式意见与旧恢复副本不同，请选择编辑起点" width={900} onCancel={() => setRecoveryCompare(false)} footer={<><Button disabled={!editing || service.state !== 'online'} onClick={() => void resolveRecovery(false)}>保留旧副本，使用正式意见</Button><Button type="primary" disabled={!editing || service.state !== 'online'} onClick={() => void resolveRecovery(true)}>保留旧副本，从它继续编辑</Button></>}>
      <p>两个版本不会自动合并。选择前会将旧恢复副本独立归档；从旧副本继续后，正式保存会以本页全部意见为准，并保留被替换的正式旧版。</p>
      <ReviewDifference key={recoveryConflict?.media.fingerprint} left={notes} right={recoveryConflict?.notes ?? []} leftLabel="正式意见" rightLabel="恢复副本" drafts={recoveryConflict ? [recoveryConflict.newDraft,recoveryConflict.editDraft,...recoveryConflict.parked] : []} onMerge={editing ? async merged => { if (!recoveryConflict) return; if (await resolveRecovery(true)) { setNotes(merged); setDirty(true); if (recoveryConflict.view.kind !== 'new' && !merged.some(note => note.id === (recoveryConflict.view as {id:string}).id)) setView({kind:'new'}); } } : undefined} />
    </Modal>
    <Modal centered open={!!conflict} title="正式意见已有另一版本，本页输入未覆盖" width={900} onCancel={() => setConflict(null)} footer={<><Button onClick={() => setConflict(null)}>保留本页，继续比对</Button><Button type="primary" danger loading={busy === 'saving'} disabled={!editing || service.state !== 'online'} onClick={() => { if (conflict) void save(conflict.finish, false, conflict.allDrafts, conflict.latest.revision); }}>保留旧版，以本页为准保存</Button></>}>
      <p>请先比对。不会自动合并两个窗口的意见；下方保存将以本页全部意见为准，服务仍会再次核对版本，并将被替换的正式记录保留到本任务的 versions 文件夹。</p>
      <ReviewDifference key={conflict?.latest.revision} left={conflict?.latest.record?.notes ?? []} right={conflict?.proposed ?? notes} leftLabel="最新正式意见" rightLabel="本页意见" drafts={[newDraft,editDraft,...parked]} onMerge={editing ? async merged => {
        if (!conflict || !media) return;
        try {
          await archiveWorkspace({format:'media-review-workspace/v4',media:media.identity,currentMs:actualTime(),notes,baseNotes,dirty,newDraft,editDraft,parked,view});
          const remaining = conflict.finish || conflict.allDrafts ? [] : view.kind === 'edit' && hasDraftWork(newDraft) ? [...parked,newDraft] : parked;
          setNotes(merged); setBaseNotes(conflict.latest.record?.notes ?? []); setRecordRevision(conflict.latest.revision); setDirty(true); setNewDraft(emptyDraft()); setEditDraft(emptyDraft()); setParked(remaining); setView({kind:'new'}); setConflict(null); setFeedback('逐条选择已带回本页；选择前的完整输入已另存恢复副本。请核对并保存。');
        } catch (cause) { message.error(cause instanceof Error ? cause.message : '原输入留存未确认，未改变选择'); }
      } : undefined} />
      {feedback && <Alert type="warning" showIcon title={feedback} />}
    </Modal>
    <Modal open={!!exportPath} title="返修资料已导出到本机" onCancel={() => setExportPath('')} footer={<Button onClick={() => setExportPath('')}>关闭</Button>}>
      <p>包含返修清单、意见记录与参考图，均使用包内相对路径。未包含原视频，也没有上传或发送。</p>
      <Input.TextArea aria-label="返修资料包目录" value={exportPath} readOnly autoSize={{ minRows: 2, maxRows: 5 }} onClick={event => event.currentTarget.select()} />
      <p>复制目录到文件资源管理器即可找到；交给其他Agent或人工时，一并提供正确的源媒体。</p>
    </Modal>
    <AnalysisActivityNotice layoutKey={`${screen}:${activeTask?.id ?? ''}`} items={tasks.data?.activity?.items ?? []} locating={analysisLocator.locating} online={service.state === 'online' && !tasks.error && tasks.data?.activity?.runtimeId === service.runtimeId} onLocate={item => void analysisLocator.locate(item)} />
    <ReviewHandoffDialog handoff={handoff} open={handoffOpen} copied={copied} copying={copying} copyError={copyError} onCopy={() => void copyHandoff()} onClose={() => setHandoffOpen(false)} onHome={() => { setHandoffOpen(false); navigate('home'); }} />
    <Modal open={!!pending} title={pending?.type === 'finish' ? '还有未完成的意见' : ['file', 'task'].includes(pending?.type ?? '') ? '先保存当前审阅，再打开其他素材' : '先处理当前未保存的意见'} closable={!busy} maskClosable={false} onCancel={() => { if (!busy) setPending(null); }} footer={<div className="switch-actions"><Button disabled={!!busy} onClick={() => { setPending(null); focusOpinion(); }}>{pending?.type === 'finish' ? '继续完成意见' : '取消，继续编辑'}</Button><Button danger disabled={!!busy} onClick={() => void resolvePending(false)}>{pending?.type === 'finish' ? '放弃未完成草稿，保存其余意见' : ['file', 'task'].includes(pending?.type ?? '') ? '放弃未保存内容并换片' : '放弃当前并继续'}</Button>{pending?.type !== 'finish' && <Button type="primary" loading={busy === 'saving'} disabled={!!busy || capturing || service.state !== 'online' || !editing || !!pendingProblem} onClick={() => void resolvePending(true)}>保存当前并继续</Button>}</div>}>
      <p>取消会保留文字、时间和画面位置；写入及回读确认前不会清空草稿。</p><p>{pendingProblem || '可以先保存当前全部意见，也可以明确放弃本页未保存的内容。'}</p>{feedback && <Alert type="error" showIcon title={feedback} />}
    </Modal>
    <Modal open={referenceOpen} title={`意见参考画面 · ${formatTime(draft.frameMs ?? 0)}`} footer={<Button onClick={() => setReferenceOpen(false)}>关闭参考画面</Button>} onCancel={() => setReferenceOpen(false)} width={760} centered>
      {targetImage && <div className="reference-full-frame" style={{ aspectRatio: referenceAspect, width: "min(100%, calc((100dvh - 270px) * " + referenceAspect + "))" }}><img src={targetImage} alt="标注当时的完整参考画面" /><FrameRegions regions={regions} selected={selectedRegion} onSelect={focusRegion} /></div>}<p className="note-safe">这是意见绑定的画面，不是播放器后来的位置；保存时与意见一起写入本机。</p>
    </Modal>
  </div>;
  const scrollOptions = useMemo(() => ({ autoRaf: true, smoothWheel: !reduced, duration: .65, prevent: (node: HTMLElement) => !!node.closest('[data-lenis-prevent],.ant-modal,.ant-select-dropdown,.waveform,.frame-layer,input,textarea') }), [reduced]);
  return <ReactLenis root options={scrollOptions}>{app}</ReactLenis>;
}
