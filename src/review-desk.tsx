import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Alert, Button, Empty, Form, Input, Modal, Popconfirm, Segmented, Select, Slider, Switch, Tag } from 'antd';
import { ArrowLeftOutlined, AudioOutlined, ClockCircleOutlined, CloseOutlined, CommentOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, HomeOutlined, InfoCircleOutlined, PauseOutlined, PlayCircleOutlined, PlusOutlined, SafetyCertificateOutlined, SaveOutlined, ScissorOutlined, SelectOutlined, SoundOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { ReactLenis } from 'lenis/react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { ServiceBadge } from './components/ServiceBadge';
import { ServiceNotice } from './components/ServiceNotice';
import { ReviewHome } from './components/ReviewHome';
import { FrameCanvas } from './components/FrameCanvas';
import { ReviewWaveform } from './components/ReviewWaveform';
import FrameStrip from './components/FrameStrip';
import { AudioCompare } from './components/AudioCompare';
import { TranscriptPanel, type TranscriptCue } from './components/TranscriptPanel';
import { ReviewHandoffDialog } from './components/ReviewHandoffDialog';
import { createReviewHandoff, type ReviewHandoff } from './lib/review-handoff';
import { loadRecord, saveRecord, loadReference, saveReference, currentWorkflowMedia, workflowFile, latestWorkspace, loadWorkspace, saveWorkspace, exportRecord, type WorkflowMedia } from './lib/api';
import { useServiceStatus } from './lib/use-service-status';
import { cacheWorkspace, cachedWorkspace, type ReviewWorkspace } from './lib/review-workspace';
import { useMediaAnalysis } from './lib/use-media-analysis';
import { emptyDraft, hasDraftWork, draftProblem, draftSignature, draftToNote, type ReviewDraft, type TargetMode } from './lib/review-draft';
import { clampMs, fingerprintFile, formatTime, KIND_LABEL, parseTime, REFERENCE_FORMAT, REVIEW_FORMAT, sortedNotes, TOPIC_LABEL, type MediaIdentity, type Rect, type ReviewNote, type ReviewTopic } from './lib/review';

interface OpenMedia { file: File; url: string; isAudio: boolean; identity: MediaIdentity; width: number; height: number }
type View = { kind: 'new' } | { kind: 'detail'; id: string } | { kind: 'edit'; id: string };
type Action = { type: 'new' } | { type: 'target'; mode: TargetMode; position: number; cue?: TranscriptCue } | { type: 'detail'; note: ReviewNote } | { type: 'restore' } | { type: 'file'; file: File } | { type: 'finish' };
const MODE_LABEL = { point: '时间点', range: '时间段', frame: '画面位置' };
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
function fromNote(note: ReviewNote): ReviewDraft {
  return { id: note.id, mode: note.endMs !== null ? 'range' : note.reference && note.rect ? 'frame' : 'point', kind: note.kind, topic: note.topic ?? null,
    startText: formatTime(note.startMs), endText: note.endMs === null ? '' : formatTime(note.endMs), text: note.text, rect: note.rect,
    frameMs: note.reference?.frameMs ?? null, reference: note.reference ?? null, snapshot: null };
}

export function ReviewDesk() {
  const { message } = App.useApp();
  const root = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), player = useRef<HTMLMediaElement>(null), stage = useRef<HTMLDivElement>(null);
  const generation = useRef(0), savingRef = useRef(false), captureSequence = useRef(0), copySequence = useRef(0), gestureBackup = useRef<ReviewDraft | null>(null);
  const auditionEnd = useRef<number | null>(null), oldVolume = useRef(75);
  const [media, setMedia] = useState<OpenMedia | null>(null);
  const [screen, setScreen] = useState<'home' | 'review'>('home');
  const [notes, setNotes] = useState<ReviewNote[]>([]), [dirty, setDirty] = useState(false);
  const [newDraft, setNewDraft] = useState(emptyDraft), [editDraft, setEditDraft] = useState(emptyDraft), [parked, setParked] = useState<ReviewDraft[]>([]);
  const [view, setView] = useState<View>({ kind: 'new' });
  const [pending, setPending] = useState<Action | null>(null), [busy, setBusy] = useState<'opening' | 'loading' | 'saving' | null>(null);
  const [selecting, setSelecting] = useState<'range' | 'frame' | null>(null), [capturing, setCapturing] = useState(false);
  const [feedback, setFeedback] = useState(''), [recordError, setRecordError] = useState(''), [mediaError, setMediaError] = useState('');
  const [recordPath, setRecordPath] = useState<string | null>(null), [saved, setSaved] = useState(false), [loadAttempt, setLoadAttempt] = useState(0);
  const [currentMs, setCurrentMs] = useState(0), [playing, setPlaying] = useState(false), [listenOnly, setListenOnly] = useState(false);
  const [rate, setRate] = useState(1), [volume, setVolume] = useState(75), [zoom, setZoom] = useState(1), [viewStart, setViewStart] = useState(0);
  const [loop, setLoop] = useState(false), [contrast, setContrast] = useState(true), [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [images, setImages] = useState<Record<string, string>>({}), [imageError, setImageError] = useState(''), [referenceOpen, setReferenceOpen] = useState(false);
  const [handoff, setHandoff] = useState<ReviewHandoff | null>(null), [handoffOpen, setHandoffOpen] = useState(false);
  const [copied, setCopied] = useState(false), [copying, setCopying] = useState(false), [copyError, setCopyError] = useState('');
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [captureCount, setCaptureCount] = useState(0);
  const service = useServiceStatus();
  const serviceError = service.state === 'incompatible' ? '这是旧服务会话。请保留当前输入，再从桌面的“声画校对室”或当前启动文件重新打开。' : '';
  const [baseNotes, setBaseNotes] = useState<ReviewNote[]>([]);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [exportPath, setExportPath] = useState(''), [exporting, setExporting] = useState(false);
  const [resumeName, setResumeName] = useState('');
  const [incoming, setIncoming] = useState<WorkflowMedia | null>(null);
  const restoring = useRef(true), seenInputs = useRef(new Set<string>());
  const workspaceTail = useRef<Promise<unknown>>(Promise.resolve());
  const durationMs = media?.identity.durationMs ?? 0;
  const analysis = useMediaAnalysis(media?.file ?? null, durationMs);
  const ordered = useMemo(() => sortedNotes(notes), [notes]);
  const selected = view.kind !== 'new' ? notes.find(note => note.id === view.id) : null;
  const draft = view.kind === 'detail' && selected ? fromNote(selected) : view.kind === 'edit' ? editDraft : newDraft;
  const reading = view.kind === 'detail';
  const editChanged = view.kind === 'edit' && !!selected && draftSignature(editDraft) !== draftSignature(fromNote(selected));
  const unsaved = dirty || hasDraftWork(newDraft) || editChanged || parked.some(hasDraftWork);
  const locked = !!busy || capturing || !!recordError || !!serviceError || !durationMs;
  const problem = draftProblem(draft, durationMs, !!selecting || capturing);
  const targetImage = draft.snapshot ?? (draft.reference ? images[draft.reference.fileName] : null);
  const span = durationMs / zoom, viewEnd = Math.min(durationMs, viewStart + span);
  const start = parseTime(draft.startText), end = parseTime(draft.endText);
  const selection = draft.mode === 'range' && start !== null && end !== null && end > start && end <= durationMs ? { start, end } : null;
  const targetTime = draft.frameMs ?? start;
  const atReference = draft.frameMs !== null && Math.abs(currentMs - draft.frameMs) < 80;
  const stateLabel = busy === 'saving' ? '正在保存到本机…' : recordError ? '旧记录保留，读取待重试' : unsaved ? '有未保存的意见' : saved ? '已保存到本机' : '尚未保存';
  const activeCue = analysis.cues.find(cue => cue.startMs <= currentMs && currentMs < cue.endMs);

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
  function patch(change: Partial<ReviewDraft>) {
    if (locked || reading) return;
    invalidate();
    if (view.kind === 'edit') setEditDraft(old => ({ ...old, ...change })); else setNewDraft(old => ({ ...old, ...change }));
  }
  function focusOpinion() {
    requestAnimationFrame(() => {
      const input = root.current?.querySelector<HTMLTextAreaElement>('#opinion-text');
      if (!input) return;
      const bounds = input.getBoundingClientRect();
      if (bounds.bottom > innerHeight - 20 || bounds.top < 100) input.scrollIntoView({ block: 'nearest', behavior: reduced ? 'instant' : 'smooth' });
      input.focus({ preventScroll: true });
    });
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
    if (loop && selection && time >= selection.end - 30) { time = selection.start; element.currentTime = time / 1000; }
    setCurrentMs(time);
    if (zoom > 1 && time > viewEnd) setViewStart(Math.min(durationMs - span, Math.max(0, time - span * .2)));
  }

  useEffect(() => {
    if (!media || !durationMs) return;
    const number = generation.current; let cancelled = false;
    restoring.current = true; setBusy('loading'); setRecordError('');
    void (async () => {
      const result = await loadRecord(media.identity.fingerprint);
      if (cancelled || number !== generation.current) return;
      const record = result.record;
      if (result.found && record && (![REVIEW_FORMAT, REFERENCE_FORMAT].includes(record.format) || record.media.fingerprint !== media.identity.fingerprint || record.media.size !== media.identity.size || record.media.name !== media.identity.name || Math.abs(record.media.durationMs - durationMs) > 1000)) throw new Error('找到记录但媒体身份不匹配，原意见未加载或覆盖。');
      const original = record?.notes ?? [];
      setNotes(original); setBaseNotes(original); setRecordPath(result.recordPath); setSaved(!!record);
      const [disk, local] = await Promise.all([
        loadWorkspace(media.identity.fingerprint).catch(() => { setRecoveryStatus('本机恢复资料暂不可读，原内容保留'); return { workspace: null, at: 0 }; }),
        cachedWorkspace(service.rootId, media.identity.fingerprint).catch(() => null),
      ]);
      if (cancelled || number !== generation.current) return;
      const restored = local && local.at > disk.at ? local.workspace : disk.workspace;
      if (restored && restored.media.fingerprint === media.identity.fingerprint && restored.media.name === media.identity.name && restored.media.size === media.identity.size && restored.media.durationMs === durationMs) {
        const sameBase = JSON.stringify(restored.baseNotes) === JSON.stringify(original);
        if (!sameBase && restored.dirty) { setRecoveryStatus('本机正式意见已变化，未用旧恢复清单覆盖；请核对原记录'); return; }
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
  }, [media?.identity.fingerprint, durationMs, loadAttempt, service.rootId]);
  useEffect(() => {
    const reference = draft.reference, fingerprint = media?.identity.fingerprint;
    setImageError('');
    if (!reference || !fingerprint || images[reference.fileName]) return;
    let cancelled = false;
    void loadReference(fingerprint, reference.fileName).then(result => { if (!cancelled) setImages(old => ({ ...old, [reference.fileName]: result.data })); })
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
  }, [media?.url, media?.width, media?.height, listenOnly, screen]);

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
      if (editing) setEditDraft(captured); else { setView({ kind: 'new' }); setNewDraft(captured); }
      invalidate(); setCaptureCount(count => count + 1);
    } catch (cause) { setFeedback(cause instanceof Error ? cause.message : '参考画面未取得，意见仍保留。'); }
    finally { if (sequence === captureSequence.current) setCapturing(false); }
  }

  async function openFile(file: File) {
    if (savingRef.current) return;
    const isAudio = file.type.startsWith('audio/') || /\.(m4a|mp3|wav|aac|ogg|flac)$/i.test(file.name);
    if (!isAudio && !file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|avi)$/i.test(file.name)) { message.error('请选择浏览器能播放的视频或音频。'); return; }
    const number = ++generation.current; captureSequence.current++; setCapturing(false);
    player.current?.pause(); analysis.stop(); setBusy('opening'); message.destroy();
    try {
      const fingerprint = await fingerprintFile(file); if (number !== generation.current) return;
      setMedia({ file, url: URL.createObjectURL(file), isAudio, identity: { name: file.name, size: file.size, type: file.type || (isAudio ? 'audio/unknown' : 'video/unknown'), durationMs: 0, fingerprint }, width: 16, height: 9 });
      setIncoming(old => old?.fingerprint === fingerprint ? null : old);
      setNotes([]); setNewDraft(emptyDraft()); setEditDraft(emptyDraft()); setParked([]); setView({ kind: 'new' }); setSelecting(null); setDirty(false); invalidate();
      setRecordPath(null); setRecordError(''); setMediaError(''); setImages({}); setImageError(''); setReferenceOpen(false); setLoop(false); setRate(1); setCurrentMs(0); setZoom(1); setViewStart(0); setListenOnly(isAudio);
      navigate('review');
    } catch (cause) { message.error(cause instanceof Error ? cause.message : '素材无法读取。'); setBusy(null); }
  }
  function chooseFile(kind?: 'video' | 'audio') {
    if (serviceError) { message.error(serviceError); return; }
    if (busy === 'saving' || !fileInput.current) return;
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
    if (gestureBackup.current) { if (view.kind === 'edit') setEditDraft(gestureBackup.current); else setNewDraft(gestureBackup.current); }
    gestureBackup.current = null;
  }
  function perform(action: Action) {
    setFeedback(''); setReferenceOpen(false); setLoop(false); auditionEnd.current = null;
    if (action.type === 'file') { void openFile(action.file); return; }
    if (action.type === 'finish') { void save(true); return; }
    if (action.type === 'detail') {
      setSelecting(null); setView({ kind: 'detail', id: action.note.id }); setEditDraft(emptyDraft());
      player.current?.pause(); seek(action.note.reference?.frameMs ?? action.note.startMs); return;
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
    if (action.type === 'new') { setNewDraft(emptyDraft()); focusOpinion(); return; }
    const value: ReviewDraft = { ...(!newDraft.mode && hasDraftWork(newDraft) ? newDraft : emptyDraft()), mode: action.mode, startText: formatTime(action.cue?.startMs ?? action.position), endText: action.cue ? formatTime(action.cue.endMs) : '', frameMs: action.mode === 'frame' ? action.position : null };
    setNewDraft(value); invalidate(); setCurrentMs(action.position); player.current?.pause();
    if (action.mode === 'range') { gestureBackup.current = value; setSelecting(action.cue ? null : 'range'); if (action.cue) seek(action.cue.startMs); else root.current?.querySelector('.sound-panel')?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
    if (action.mode === 'frame') { setListenOnly(false); gestureBackup.current = value; setSelecting('frame'); void captureFrame(action.position, value); }
    if (action.mode !== 'frame') focusOpinion();
  }
  function request(action: Action) {
    if (savingRef.current || (locked && action.type !== 'file')) return;
    const boundNew = hasDraftWork(newDraft) && (newDraft.mode !== null || action.type === 'new');
    const shouldGuard = action.type === 'file' ? unsaved : action.type === 'detail' || action.type === 'restore' ? editChanged : editChanged || boundNew;
    if (shouldGuard) { player.current?.pause(); setPending(action); return; }
    perform(action);
  }
  function requestTarget(mode: TargetMode, cue?: TranscriptCue) {
    if (locked || (mode === 'frame' && media?.isAudio)) return;
    const position = actualTime(); player.current?.pause();
    request({ type: 'target', mode, position, cue });
  }
  function showNote(note: ReviewNote) { request({ type: 'detail', note }); }
  function discardCurrent() {
    if (view.kind === 'edit') setEditDraft(emptyDraft()); else setNewDraft(emptyDraft());
    setSelecting(null); captureSequence.current++; setCapturing(false); setFeedback('');
  }

  async function save(finish = false, discardIncomplete = false, allDrafts = false): Promise<boolean> {
    if (!media || !durationMs || busy || savingRef.current || recordError) return false;
    if (service.state !== 'online') { setFeedback('服务尚未连接，不能确认保存。请保留本页，从桌面入口重开；当前草稿不清空。'); return false; }
    const number = generation.current;
    let drafts = finish || allDrafts ? [...(view.kind === 'edit' && editChanged ? [editDraft] : []), newDraft, ...parked].filter(hasDraftWork) : [view.kind === 'edit' ? editDraft : newDraft].filter(hasDraftWork);
    const unfinished = drafts.find(value => draftProblem(value, durationMs, value === draft && (!!selecting || capturing)));
    if (unfinished && !discardIncomplete) {
      if (finish) setPending({ type: 'finish' });
      else setFeedback(draftProblem(unfinished, durationMs, !!selecting || capturing));
      return false;
    }
    if (discardIncomplete) drafts = drafts.filter(value => !draftProblem(value, durationMs, value === draft && (!!selecting || capturing)));
    if (finish && !notes.length && !drafts.length) { setFeedback('还没有可交接的意见。先留下至少一条意见。'); return false; }
    savingRef.current = true; setBusy('saving'); setFeedback(''); message.destroy();
    try {
      let updated = notes;
      for (const value of drafts) {
        let reference = value.reference;
        if (value.snapshot && value.frameMs !== null && !reference) reference = { ...await saveReference(media.identity.fingerprint, value.snapshot), frameMs: value.frameMs };
        const note = draftToNote({ ...value, reference }, durationMs);
        updated = sortedNotes([...updated.filter(item => item.id !== note.id), note]);
      }
      const receipt = await saveRecord({ format: REFERENCE_FORMAT, media: media.identity, notes: updated });
      if (number !== generation.current) return false;
      const remainingDrafts = finish || allDrafts ? [] : view.kind === 'edit' && hasDraftWork(newDraft) ? [...parked, newDraft] : parked;
      const cleared: ReviewWorkspace = { format: 'media-review-workspace/v1', media: media.identity, currentMs: actualTime(), notes: receipt.record.notes, baseNotes: receipt.record.notes, dirty: false, newDraft: emptyDraft(), editDraft: emptyDraft(), parked: remainingDrafts, view: { kind: 'new' } };
      workspaceTail.current = workspaceTail.current.catch(() => {}).then(async () => {
        const outcomes = await Promise.allSettled([cacheWorkspace(service.rootId, cleared), saveWorkspace(cleared)]);
        if (outcomes.every(result => result.status === 'rejected')) setRecoveryStatus('正式意见已保存，但恢复副本清理未确认；请保留本页');
      });
      await workspaceTail.current;
      if (number !== generation.current) return false;
      setParked(remainingDrafts);
      setNotes(receipt.record.notes); setBaseNotes(receipt.record.notes); setRecordPath(receipt.recordPath); setDirty(false);
      setNewDraft(emptyDraft()); setEditDraft(emptyDraft()); setView({ kind: 'new' }); setSelecting(null); setSaved(true);
      setHandoff(receipt.record.notes.length ? createReviewHandoff(receipt) : null); setHandoffOpen(finish); setCopied(false); setCopyError(''); setPending(null);
      if (!finish) { message.success('已保存到本机，可以继续写下一条。'); focusOpinion(); }
      return true;
    } catch (cause) { if (number === generation.current) setFeedback(cause instanceof Error ? cause.message : '保存未确认，输入仍保留，可以重试。'); return false; }
    finally { savingRef.current = false; if (number === generation.current) setBusy(null); }
  }
  async function resolvePending(saveFirst: boolean) {
    const action = pending; if (!action) return;
    if (action.type === 'finish') { if (saveFirst) return; await save(true, true); return; }
    if (saveFirst) { if (!await save(false, false, action.type === 'file')) return; }
    else {
      if (view.kind === 'edit' && hasDraftWork(newDraft) && (action.type === 'new' || action.type === 'target')) setParked(old => [...old, newDraft]);
      discardCurrent(); if (action.type === 'file') { setParked([]); setDirty(false); }
    }
    setPending(null);
    if (action.type === 'target') {
      const value: ReviewDraft = { ...emptyDraft(), mode: action.mode, startText: formatTime(action.cue?.startMs ?? action.position), endText: action.cue ? formatTime(action.cue.endMs) : '', frameMs: action.mode === 'frame' ? action.position : null };
      setNewDraft(value); setView({ kind: 'new' }); setEditDraft(emptyDraft()); invalidate();
      if (action.mode === 'frame') { setListenOnly(false); gestureBackup.current = value; setSelecting('frame'); void captureFrame(action.position, value); }
      else if (action.mode === 'range') { gestureBackup.current = value; setSelecting(action.cue ? null : 'range'); if (action.cue) seek(action.cue.startMs); }
      else setSelecting(null);
      focusOpinion();
    } else perform(action);
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
    seek(selection.start); auditionEnd.current = loop ? null : selection.end; void player.current.play().catch(() => setMediaError('当前选段暂不能播放。'));
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
      if (screen !== 'review' || pending || handoffOpen || referenceOpen || event.defaultPrevented) return;
      if (event.key === 'Escape' && selecting) { event.preventDefault(); cancelSelection(); return; }
      if ((event.target as HTMLElement)?.closest('input,textarea,button,[role="slider"],[role="combobox"],[role="radio"],.ant-modal,[contenteditable]')) return;
      if (event.code === 'Space') { event.preventDefault(); void togglePlay(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seek(actualTime() + (event.key === 'ArrowLeft' ? -1000 : 1000)); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });

  const workflowActions = useRef({ media, unsaved, busy, openFile, request });
  workflowActions.current = { media, unsaved, busy, openFile, request };
  async function bringIn(value: WorkflowMedia) {
    try {
      const file = await workflowFile(value);
      if (await fingerprintFile(file) !== value.fingerprint) throw new Error('成片身份不一致，未打开或覆盖旧意见');
      workflowActions.current.request({ type: 'file', file });
    } catch (cause) { setIncoming(value); setRecoveryStatus(cause instanceof Error ? cause.message : '带入未完成，可重试'); }
  }
  useEffect(() => {
    if (service.state !== 'online') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { media: value } = await currentWorkflowMedia();
        if (!stopped && value && !seenInputs.current.has(value.id)) {
          seenInputs.current.add(value.id);
          const current = workflowActions.current;
          if (current.media?.identity.fingerprint !== value.fingerprint) {
            if (current.unsaved || current.busy) setIncoming(value);
            else await bringIn(value);
          }
        }
      } catch { /* 连接状态由心跳负责；不清空用户工作。 */ }
      finally { if (!stopped) timer = setTimeout(poll, 3000); }
    };
    void poll();
    void latestWorkspace().then(value => { if (!stopped && value.workspace) setResumeName(value.workspace.media.name); }).catch(() => {});
    return () => { stopped = true; clearTimeout(timer); };
  }, [service.state]);
  useEffect(() => {
    if (!media || !durationMs || busy || restoring.current || recordError || !service.rootId) return;
    const workspace: ReviewWorkspace = { format: 'media-review-workspace/v1', media: media.identity, currentMs: actualTime(), notes, baseNotes, dirty, newDraft, editDraft, parked, view };
    let cancelled = false;
    setRecoveryStatus('正在保留恢复副本…');
    const timer = setTimeout(() => {
      workspaceTail.current = workspaceTail.current.catch(() => {}).then(async () => {
        await cacheWorkspace(service.rootId, workspace);
        if (!cancelled) setRecoveryStatus('浏览器恢复副本已保留，未替代正式保存');
        if (service.state === 'online') {
          await saveWorkspace(workspace);
          if (!cancelled) setRecoveryStatus('本机恢复副本已保留，未替代正式保存');
        }
      }).catch(() => { if (!cancelled) setRecoveryStatus('恢复副本未完全确认；请保留本页并尽快正式保存'); });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [newDraft, editDraft, parked, view, notes, baseNotes, dirty, durationMs, media?.url, busy, playing, service.state, service.rootId, recordError]);

  const reference = <div className="note-target">
    {targetImage ? <Button className="target-preview" type="text" aria-label="放大查看这条意见的参考画面" onClick={() => { player.current?.pause(); setReferenceOpen(true); }}>
      <span className="target-frame" style={{ aspectRatio: draft.reference ? `${draft.reference.width}/${draft.reference.height}` : `${media?.width}/${media?.height}` }}><img src={targetImage} alt="这条意见的完整参考画面" />{draft.rect && <span className="thumb-rect" style={{ left: `${draft.rect.x * 100}%`, top: `${draft.rect.y * 100}%`, width: `${draft.rect.width * 100}%`, height: `${draft.rect.height * 100}%` }} />}</span>
    </Button> : <div className="target-empty">{draft.mode === 'range' ? <ScissorOutlined /> : draft.mode === 'frame' ? <SelectOutlined /> : <ClockCircleOutlined />}</div>}
    <div className="target-text"><small>{draft.mode ? `本条意见 · ${MODE_LABEL[draft.mode]}` : '这条意见针对哪里？'}</small><strong>{draft.mode === 'range' ? `${draft.startText || '待选开始'} — ${draft.endText || '待选结束'}` : draft.startText || '先选一个位置'}</strong>
      <p>{draft.frameMs !== null ? `参考帧 ${formatTime(draft.frameMs)} · 与播放位置独立` : reading && draft.rect ? '旧记录未记录独立参考帧，未猜补截图' : '播放、点击台词不会改变意见目标'}</p>
      {targetTime !== null && <Button type="link" size="small" onClick={() => { player.current?.pause(); seek(targetTime); }}>返回标注位置</Button>}
      {!reading && draft.mode === 'range' && <Button type="link" size="small" disabled={locked || service.state !== 'online'} onClick={() => { gestureBackup.current = draft; setSelecting('range'); }}>调整这段时间</Button>}
      {!reading && draft.mode === 'range' && !media?.isAudio && <Button type="link" size="small" disabled={locked || service.state !== 'online'} onClick={() => { const position = actualTime(); player.current?.pause(); gestureBackup.current = draft; setSelecting('frame'); void captureFrame(position, draft, view.kind === 'edit'); }}>给这段附加参考画面</Button>}
      {!reading && draft.mode === 'frame' && !selecting && !draft.rect && <Button type="link" size="small" disabled={locked || service.state !== 'online'} onClick={() => { const position = draft.frameMs ?? actualTime(); player.current?.pause(); seek(position); gestureBackup.current = draft; setSelecting('frame'); void captureFrame(position, draft, view.kind === 'edit'); }}>继续框选这条意见</Button>}
    </div>
  </div>;
  const composition = <section className="opinion" aria-label="常驻意见栏">
    <div className="opinion-head"><h2>{reading ? '意见详情' : view.kind === 'edit' ? '修改这条意见' : '写下这条意见'}</h2><Tag>{reading ? KIND_LABEL[draft.kind] : view.kind === 'edit' ? '正在编辑' : '新意见'}</Tag></div>
    <p className="opinion-instruction">{reading ? '已定位这条意见；查看不会覆盖你的新草稿。' : '先写想法也可以，再选位置。目标不会随播放变化。'}</p>
    {reference}{imageError && <p className="save-error" role="alert">{imageError}</p>}
    {reading ? <><div className="note-read-text">{draft.text}</div>{draft.topic && <p className="note-safe">问题类别：{TOPIC_LABEL[draft.topic]}</p>}
      <div className="note-footer"><Button type="primary" icon={<EditOutlined />} disabled={locked || service.state !== 'online'} onClick={() => { if (!selected) return; setEditDraft(fromNote(selected)); setView({ kind: 'edit', id: selected.id }); setFeedback(''); focusOpinion(); }}>修改这条意见</Button>
        {(hasDraftWork(newDraft) || parked.length > 0) && <Button onClick={() => request({ type: 'restore' })}>返回未保存草稿</Button>}</div></> : <Form layout="vertical" onFinish={() => void save()} disabled={locked}>
      <Form.Item className="kind-field" label="意见类型"><Segmented block aria-label="意见类型" value={draft.kind} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} onChange={value => patch({ kind: value as ReviewDraft['kind'] })} /></Form.Item>
      <details className="note-options"><summary>调整时间／选择问题类别</summary><div className="time-input-row"><Form.Item label={draft.mode === 'range' ? '开始时间' : '标注时间'}><Input aria-label="开始时间" value={draft.startText} placeholder="00:00.000" disabled={!draft.mode || draft.mode === 'frame' || locked} onChange={event => patch({ startText: event.target.value })} /></Form.Item>
        {draft.mode === 'range' && <Form.Item label="结束时间"><Input aria-label="结束时间" value={draft.endText} placeholder="00:00.000" onChange={event => patch({ endText: event.target.value })} /></Form.Item>}</div>
      {draft.mode === 'range' && <div className="capture-row"><Button type="link" size="small" onClick={() => patch({ startText: formatTime(actualTime()) })}>设当前为开始</Button><Button type="link" size="small" onClick={() => patch({ endText: formatTime(actualTime()) })}>设当前为结束</Button></div>}
      <Form.Item label="问题类别（可选）"><Select aria-label="问题类别" allowClear value={draft.topic ?? undefined} placeholder="画面、字幕、声音、节奏…" options={Object.entries(TOPIC_LABEL).filter(([key]) => !media?.isAudio || key !== 'visual').map(([value, label]) => ({ value, label }))} onChange={value => patch({ topic: (value ?? null) as ReviewTopic | null })} /></Form.Item></details>
      <Form.Item label="你的意见" htmlFor="opinion-text"><Input.TextArea id="opinion-text" aria-label="你的意见" value={draft.text} maxLength={2000} autoSize={{ minRows: 3, maxRows: 7 }} placeholder="这段画面、声音、字幕或节奏，希望怎么改？" onChange={event => patch({ text: event.target.value })} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void save(); } }} /></Form.Item>
      <Button className="save-note" block type="primary" htmlType="submit" icon={<SaveOutlined />} loading={busy === 'saving'} disabled={locked || service.state !== 'online' || !!problem}>{view.kind === 'edit' ? '保存这条修改' : '保存这条意见'}</Button>
      <p className="note-safe" role="status">{service.state !== 'online' ? '连接不可用，当前无法保存。输入仍在本页，请按上方提示重新打开校对室。' : problem || '可保存；写入并回读确认后，进入空白新意见。'}</p>
      {view.kind === 'edit' && <Button type="link" disabled={locked || service.state !== 'online'} onClick={() => selected && request({ type: 'detail', note: selected })}>取消编辑，查看原意见</Button>}
    </Form>}
    {draft.rect && <details className="coordinate-details"><summary>画面坐标 · 相对实际画幅</summary><div className="coordinate-fields">{(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>{['横向', '纵向', '宽', '高'][index]}<Input aria-label={`画面${key}`} value={(draft.rect![key] * 100).toFixed(1)} suffix="%" readOnly={reading || locked} onChange={event => {
      const value = Number(event.target.value) / 100; if (!Number.isFinite(value)) return;
      const next: Rect = { ...draft.rect!, [key]: Math.min(key === 'x' || key === 'y' ? .98 : 1, clamp01(value)) }; next.width = Math.min(Math.max(.02, next.width), 1 - next.x); next.height = Math.min(Math.max(.02, next.height), 1 - next.y); patch({ rect: next });
    }} /></label>)}</div></details>}
    {feedback && <p className="save-error" role="alert">{feedback}</p>}
  </section>;

  const app = <div className="review-app scheme-a" ref={root} data-ui-revision="history-20261009-r2">
    <header className="brandbar"><div className="brand"><img src="/brand/review-mark.svg" alt="Media Review" /><strong>Media Review</strong><span className="tool-name">音视频校对</span></div>
      <div className="brand-actions"><ServiceBadge state={service.state} /><span className="privacy"><SafetyCertificateOutlined />素材留在本机</span>{media && <><span className="save-indicator" role="status">{stateLabel}</span><Button icon={screen === 'home' ? <ArrowLeftOutlined /> : <HomeOutlined />} disabled={busy === 'saving'} onClick={() => navigate(screen === 'home' ? 'review' : 'home')}>{screen === 'home' ? '返回当前素材' : '回到主页'}</Button></>}<Button icon={<FolderOpenOutlined />} disabled={busy === 'saving'} onClick={() => chooseFile()}>打开其他素材</Button>{media && <Button className="save-button" icon={<SaveOutlined />} disabled={locked || service.state !== 'online'} loading={busy === 'saving'} onClick={() => void save()}>保存进度</Button>}{media && <Button type="primary" icon={<CommentOutlined />} loading={busy === 'saving'} disabled={locked || service.state !== 'online'} onClick={() => void save(true)}>保存并交给 Agent</Button>}</div>
      <input ref={fileInput} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) request({ type: 'file', file }); }} />
    </header>
    <ServiceNotice state={service.state} />
    {incoming && <Alert className="service-notice" type="info" showIcon title={`Agent已送来：${incoming.name}`} description="当前工作不自动替换；打开前仍会处理未保存的意见。" action={<Button onClick={() => void bringIn(incoming)}>打开这版视频</Button>} />}
    {screen === 'home' && !media && resumeName && <Alert className="service-notice" type="info" showIcon title={`上次审阅：${resumeName}`} description="Agent带入的素材会自动恢复；手选素材请重新选择同一文件，随后恢复时间和意见草稿。" />}
    {screen === 'home' && <ReviewHome hasMedia={!!media} online={service.state === 'online'} onOpen={chooseFile} onResume={() => navigate('review')} />}
    {media && <main className={`workspace-wrap ${listenOnly ? 'audio-view' : ''}`} style={{ display: screen === 'review' ? undefined : 'none' }}>
      <div className="project-row"><div className="project-name"><span className="media-kind">{media.isAudio ? <AudioOutlined /> : <VideoCameraOutlined />}</span><div><h1 title={media.file.name}>{media.file.name}</h1><small>{media.isAudio ? '本机录音' : `${media.width} × ${media.height} · 完整画面`} · {formatTime(durationMs, false)} · 时间从0开始</small></div></div><div className="step-line"><span><b>01</b>打开素材</span><span className="on"><b>02</b>找到位置</span><span><b>03</b>写意见并交接</span></div></div>
      {recordError && <Alert type="error" showIcon title="已有意见未能读取，原记录保留" description={recordError} action={<Button onClick={() => setLoadAttempt(value => value + 1)}>重试读取</Button>} />}
      <div className="workspace"><section className="review-main" aria-label="媒体审阅区">
        <section className="surface"><div className="surface-tools"><span className="surface-label">新建标注</span><div className="surface-actions"><Button disabled={locked || service.state !== 'online'} icon={<ClockCircleOutlined />} onClick={() => requestTarget('point')}>标记时间点</Button><Button disabled={locked || service.state !== 'online'} icon={<ScissorOutlined />} onClick={() => requestTarget('range')}>选择时间段</Button>{!media.isAudio && <Button disabled={locked || service.state !== 'online'} icon={<SelectOutlined />} onClick={() => requestTarget('frame')}>框选当前画面</Button>}{selecting && <Button disabled={busy === 'saving'} icon={<CloseOutlined />} onClick={cancelSelection}>取消选取</Button>}</div></div>
          <div ref={stage} className={`viewer ${listenOnly ? 'audio-mode' : ''} ${media.width / media.height > 1 ? 'landscape' : ''}`}>
            {media.isAudio ? <audio ref={player as React.RefObject<HTMLAudioElement>} data-primary-media src={media.url} preload="auto" onLoadedMetadata={metadata} onDurationChange={metadata} onTimeUpdate={onTimeUpdate} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setMediaError('浏览器无法播放此音频，请检查编码或换用可播放文件。'); setBusy(null); analysis.stop(); }} /> : <div className="video-holder" style={{ width: frameSize.width, height: frameSize.height, visibility: listenOnly ? 'hidden' : undefined }}>
              <video ref={player as React.RefObject<HTMLVideoElement>} data-primary-media src={media.url} playsInline preload="auto" aria-label="当前原始视频" onLoadedMetadata={metadata} onDurationChange={metadata} onTimeUpdate={onTimeUpdate} onPlay={() => { setPlaying(true); setSelecting(null); }} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setMediaError('浏览器无法播放此视频，请检查编码或换用MP4。'); setBusy(null); analysis.stop(); }} />
              {!playing && !listenOnly && reading && atReference && draft.rect && <div className="frame-layer readonly"><span className="region-rect" style={{ left: `${draft.rect.x * 100}%`, top: `${draft.rect.y * 100}%`, width: `${draft.rect.width * 100}%`, height: `${draft.rect.height * 100}%` }} /></div>}
              {!playing && !listenOnly && !reading && !capturing && (selecting === 'frame' || (atReference && draft.rect)) && <FrameCanvas key={`${view.kind}-${draft.id ?? 'new'}-${draft.frameMs}`} rect={draft.rect} drawing={selecting === 'frame'} onChange={rect => { if (!reading) patch({ rect }); }} onDone={rect => { patch({ rect }); setSelecting(null); gestureBackup.current = null; focusOpinion(); }} />}
              {selecting === 'frame' && <span className="draw-hint">在这一帧上拖框，松开后在旁边写意见</span>}
            </div>}
            {listenOnly ? <div className="audio-face"><div className="audio-title"><AudioOutlined />听原声，按位置留下意见</div><div className="audio-large-clock">{formatTime(currentMs, false)}<small>.{String(currentMs % 1000).padStart(3, '0')}</small></div><p className="audio-caption">{activeCue?.text ?? '点击右侧一句台词，或在下方时间轴上找到位置。'}</p><div className="audio-mini"><InfoCircleOutlined />播放位置只描述正在听哪里，不会改变意见目标。</div></div> : <><div className="viewer-side"><span>正在看的位置</span><strong>{formatTime(currentMs)}</strong><span>框选会暂停在此刻</span></div><div className="viewer-hint"><InfoCircleOutlined />继续播放时旧框会隐藏，参考画面仍留在意见旁。</div></>}
            {mediaError && <div className="media-error" role="alert">{mediaError}</div>}
          </div>
          <div className="transport"><Button className="transport-play" aria-label={playing ? '暂停' : '播放'} icon={playing ? <PauseOutlined /> : <PlayCircleOutlined />} disabled={!durationMs || capturing} onClick={() => void togglePlay()} /><strong className="clock">{formatTime(currentMs)}</strong><small>/ {formatTime(durationMs, false)}</small><Slider className="media-seek" ariaLabelForHandle="播放位置" min={0} max={Math.max(1, durationMs)} step={10} value={currentMs} onChange={seek} tooltip={{ formatter: value => formatTime(value ?? 0) }} disabled={!durationMs || capturing} /><Select className="speed-select" size="small" aria-label="播放速度" value={rate} options={[.5, .75, 1, 1.25, 1.5, 2].map(value => ({ value, label: `${value}×` }))} onChange={value => { setRate(value); if (player.current) player.current.playbackRate = value; }} /></div>
        </section>
        <section className="sound-panel" aria-label="时间定位与选段"><div className="sound-head"><div className="sound-title"><AudioOutlined /><strong>波形与时间轴</strong><small>画面、声音共用时间范围</small></div><div className="sound-actions"><Button icon={<ScissorOutlined />} disabled={locked || service.state !== 'online'} onClick={() => requestTarget('range')}>选择时间段</Button><label className="contrast"><Switch size="small" checked={contrast} onChange={setContrast} aria-label="增强强弱对比" />强弱增强</label></div></div>
          <div className="timeline-tools"><Button size="small" aria-label="时间轴向前" disabled={zoom === 1} onClick={() => setViewStart(Math.max(0, viewStart - span * .7))}>←</Button><Button size="small" aria-label="时间轴向后" disabled={zoom === 1} onClick={() => setViewStart(Math.min(durationMs - span, viewStart + span * .7))}>→</Button><Button size="small" aria-label="缩小时间轴" disabled={zoom === 1} onClick={() => changeZoom(zoom / 1.5)}>−</Button><Button size="small" aria-label="放大时间轴" disabled={zoom === 16} onClick={() => changeZoom(zoom * 1.5)}>＋</Button><Button size="small" disabled={zoom === 1} onClick={() => changeZoom(1)}>全览</Button><span>{zoom.toFixed(1)}×</span>{selecting === 'range' && <Button size="small" onClick={cancelSelection}>取消选段</Button>}</div>
          <ReviewWaveform peaks={analysis.peaks} durationMs={durationMs} currentMs={currentMs} viewStartMs={viewStart} viewEndMs={viewEnd} selection={selection} selecting={selecting === 'range'} disabled={!durationMs || !!busy || capturing} large={listenOnly} contrast={contrast} notes={ordered} onSeek={seek} onNote={showNote} onRangeChange={(begin, finish) => { player.current?.pause(); patch({ mode: 'range', startText: formatTime(begin), endText: formatTime(finish) }); }} onRangeDone={() => { setSelecting(null); gestureBackup.current = null; focusOpinion(); }} onRangeCancel={cancelSelection} />
          <div className="sound-foot"><span>{formatTime(viewStart, false)}</span><span>{selecting === 'range' ? '在时间轴上拖选起止' : selection ? `${formatTime(selection.start)} — ${formatTime(selection.end)}` : '点击定位，或先点“选择时间段”再拖选'}</span><span>{formatTime(viewEnd, false)}</span></div>
          <div className="wave-bottom"><span>{analysis.peaks.length ? '真实RMS · 整段统一标尺 · 不改变音量' : analysis.waveError || (analysis.running ? '正在本机计算波形，仍可按时间标记。' : '波形暂不可用，仍可按时间标记。')}</span>{selection && <><Button size="small" type="text" icon={<PlayCircleOutlined />} onClick={playRange}>回放选段</Button><label><Switch size="small" checked={loop} onChange={setLoop} />循环</label></>}</div>
          <div className="player-options"><label><Button type="text" size="small" icon={<SoundOutlined />} aria-label={volume ? '静音' : '取消静音'} onClick={() => { if (volume) { oldVolume.current = volume; setVolume(0); } else setVolume(oldVolume.current || 75); }} /><Slider ariaLabelForHandle="音量" min={0} max={100} value={volume} onChange={setVolume} /><span>{volume}%</span></label>{!media.isAudio && <label><Switch size="small" checked={listenOnly} onChange={value => { setListenOnly(value); cancelSelection(); }} />只听声音</label>}</div>
          <details className="wave-data" data-lenis-prevent><summary>查看波形数值</summary><div><table><thead><tr><th>时间窗起点</th><th>RMS</th></tr></thead><tbody>{analysis.peaks.map((value, index) => <tr key={index}><td>{formatTime(index / analysis.peaks.length * durationMs)}</td><td>{value.toFixed(5)}</td></tr>)}</tbody></table></div></details>
        </section>
        {!media.isAudio && <details className="frame-disclosure"><summary>画面索引 · 点击定位</summary><FrameStrip url={media.url} durationMs={durationMs} currentMs={currentMs} onSeek={seek} viewStartMs={viewStart} viewEndMs={viewEnd} /></details>}
        {listenOnly && <details className="compare-disclosure"><summary>对照另一版声音 · 同起点A/B试听</summary><AudioCompare sourceUrl={media.url} sourceDurationMs={durationMs} currentMs={currentMs} sourcePlaying={playing} sourceName={media.file.name} onPauseSource={() => player.current?.pause()} onSeekSource={seek} /></details>}
      </section><aside className="side-column" aria-label="意见与台词">
        <section className="preview-list" aria-label="意见清单"><header><strong>意见清单</strong><span className="list-count"><small>按时间排列</small><output>{notes.length}</output></span></header><p className="list-instruction">点击查看完整意见，并回到对应时间和画面。</p><div className="list-create"><Button icon={<PlusOutlined />} disabled={locked || service.state !== 'online'} onClick={() => request({ type: 'new' })}>新建意见</Button>{parked.length > 0 && <Button size="small" onClick={() => request({ type: 'restore' })}>恢复未保存草稿（{parked.length}）</Button>}</div>
          {ordered.length ? <ol data-lenis-prevent>{ordered.map((note, index) => <li key={note.id} data-review-id={note.id}><Button className={`review-item ${view.kind !== 'new' && note.id === view.id ? 'current' : ''}`} type="text" disabled={!!busy} onClick={() => showNote(note)} onKeyDown={event => {
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const buttons = root.current?.querySelectorAll<HTMLButtonElement>('.review-item'); if (!buttons?.length) return; buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))].focus(); }
          }}><span className="review-number">{String(index + 1).padStart(2, '0')}</span><span className="review-item-copy"><span className="review-item-meta"><strong>{formatTime(note.startMs)}{note.endMs !== null ? ` — ${formatTime(note.endMs)}` : ''}</strong><span>{KIND_LABEL[note.kind]}</span></span><span className="review-item-text">{note.text}</span></span></Button></li>)}</ol> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={recordError ? '记录未读回，不代表没有意见' : '保存后的意见会出现在这里'} />}
          <div className="list-foot"><span>清单较多时可在这里滚动</span>{selected && <Popconfirm title="移除这条意见？" description="保存后才更新本机记录，原媒体不变。" okText="移除" cancelText="取消" onConfirm={() => { setNotes(old => old.filter(note => note.id !== selected.id)); if (view.kind === 'edit') setEditDraft(emptyDraft()); setView({ kind: 'new' }); setDirty(true); invalidate(); }}><Button type="text" danger size="small" icon={<DeleteOutlined />} disabled={locked || service.state !== 'online'}>移除所选</Button></Popconfirm>}</div>
        </section>
        {composition}
        <section className="transcript"><header className="transcript-head"><strong>按句找位置</strong><span>点击整句可跳转</span></header><TranscriptPanel disabled={locked || service.state !== 'online'} mediaKey={media.url} cues={analysis.cues} status={analysis.status} error={analysis.error} progress={analysis.progress} elapsedMs={analysis.elapsedMs} onCancel={analysis.stop} onRetry={analysis.retry} currentMs={currentMs} durationMs={durationMs} onSeek={seek} onMark={cue => requestTarget('range', cue)} /></section>
        {handoff && !unsaved && <Button icon={<CommentOutlined />} onClick={() => setHandoffOpen(true)}>查看已保存的交接内容</Button>}
        {notes.length > 0 && <Button loading={exporting} disabled={unsaved || !!busy || service.state !== 'online'} onClick={async () => {
          setExporting(true);
          try { const result = await exportRecord(media.identity.fingerprint); if (!result.exported) throw new Error('导出未确认'); setExportPath(result.directory); }
          catch (cause) { message.error(cause instanceof Error ? cause.message : '导出未完成，原意见保留'); }
          finally { setExporting(false); }
        }}>导出返修资料包</Button>}
        {recordPath && <details className="record-actions"><summary>查看本机意见记录位置</summary><p>{recordPath}</p></details>}
      </aside></div>
      <div className="recovery-status" role="status">{recoveryStatus}</div>
      <div className="bottom-hint"><span>空格播放／暂停 · ← →定位 · Esc取消选取 · Ctrl／⌘＋Enter保存意见</span><span>原素材只读 · 精确剪点回源核对</span></div><p className="font-credit"><a href="/licenses/MiSans-License.pdf" target="_blank" rel="noopener">本页使用 MiSans · © Xiaomi</a></p>
    </main>}
    <Modal open={!!exportPath} title="返修资料已导出到本机" onCancel={() => setExportPath('')} footer={<Button onClick={() => setExportPath('')}>关闭</Button>}>
      <p>包含返修清单、意见记录与参考图，均使用包内相对路径。未包含原视频，也没有上传或发送。</p>
      <Input.TextArea aria-label="返修资料包目录" value={exportPath} readOnly autoSize={{ minRows: 2, maxRows: 5 }} onClick={event => event.currentTarget.select()} />
      <p>复制目录到文件资源管理器即可找到；交给其他Agent或人工时，一并提供正确的源媒体。</p>
    </Modal>
    <ReviewHandoffDialog handoff={handoff} open={handoffOpen} copied={copied} copying={copying} copyError={copyError} onCopy={() => void copyHandoff()} onClose={() => setHandoffOpen(false)} onHome={() => { setHandoffOpen(false); navigate('home'); }} />
    <Modal open={!!pending} title={pending?.type === 'finish' ? '还有未完成的意见' : pending?.type === 'file' ? '先保存当前审阅，再打开其他素材' : '先处理当前未保存的意见'} closable={!busy} maskClosable={false} onCancel={() => { if (!busy) setPending(null); }} footer={<div className="switch-actions"><Button disabled={!!busy} onClick={() => { setPending(null); focusOpinion(); }}>{pending?.type === 'finish' ? '继续完成意见' : '取消，继续编辑'}</Button><Button danger disabled={!!busy} onClick={() => void resolvePending(false)}>{pending?.type === 'finish' ? '放弃未完成草稿，保存其余意见' : pending?.type === 'file' ? '放弃未保存内容并换片' : '放弃当前并继续'}</Button>{pending?.type !== 'finish' && <Button type="primary" loading={busy === 'saving'} disabled={!!busy || capturing || service.state !== 'online' || !!draftProblem(view.kind === 'edit' ? editDraft : newDraft, durationMs, !!selecting)} onClick={() => void resolvePending(true)}>保存当前并继续</Button>}</div>}>
      <p>取消会保留文字、时间和画面位置；写入及回读确认前不会清空草稿。</p><p>{draftProblem(view.kind === 'edit' ? editDraft : newDraft, durationMs, !!selecting) || '可以先保存当前意见，也可以明确放弃。'}</p>{feedback && <Alert type="error" showIcon title={feedback} />}
    </Modal>
    <Modal open={referenceOpen} title={`意见参考画面 · ${formatTime(draft.frameMs ?? 0)}`} footer={<Button onClick={() => setReferenceOpen(false)}>关闭参考画面</Button>} onCancel={() => setReferenceOpen(false)} width={760} centered>
      {targetImage && <div className="reference-full-frame" style={{ aspectRatio: draft.reference ? `${draft.reference.width}/${draft.reference.height}` : `${media?.width}/${media?.height}` }}><img src={targetImage} alt="标注当时的完整参考画面" />{draft.rect && <span className="thumb-rect" style={{ left: `${draft.rect.x * 100}%`, top: `${draft.rect.y * 100}%`, width: `${draft.rect.width * 100}%`, height: `${draft.rect.height * 100}%` }} />}</div>}<p className="note-safe">这是意见绑定的画面，不是播放器后来的位置；保存时与意见一起写入本机。</p>
    </Modal>
  </div>;
  const scrollOptions = useMemo(() => ({ autoRaf: true, smoothWheel: !reduced, duration: .65, prevent: (node: HTMLElement) => !!node.closest('[data-lenis-prevent],.ant-modal,.ant-select-dropdown,.waveform,.frame-layer,input,textarea') }), [reduced]);
  return <ReactLenis root options={scrollOptions}>{app}</ReactLenis>;
}
