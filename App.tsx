import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, FunctionDeclaration, Type, LiveSession, LiveServerMessage, Modality } from '@google/genai';
import { Note, SessionRecord } from './types';
import { createPcmBlob } from './utils/audioUtils';
import { MicrophoneIcon, StopIcon, LightbulbIcon, QuestionIcon, ChevronDownIcon, ChevronUpIcon, CogIcon, ArchiveIcon, InfoIcon, HistoryIcon, CloseIcon } from './components/IconComponents';

const MAX_SESSION_TIME_SECONDS = 600;

const addNoteFunctionDeclaration: FunctionDeclaration = { name: 'addNote', parameters: { type: Type.OBJECT, description: 'Usa esta función para añadir un tip importante, una tarea o un punto clave a las notas.', properties: { tip: { type: Type.STRING, description: 'El contenido del tip o tarea. Por ejemplo: "Recordar investigar las fases del neurodesarrollo humano."' } }, required: ['tip'] } };
const answerQuestionFunctionDeclaration: FunctionDeclaration = { name: 'answerQuestion', parameters: { type: Type.OBJECT, description: 'Usa esta función cuando se hace una pregunta directa y conoces la respuesta.', properties: { question: { type: Type.STRING, description: 'La pregunta que se hizo. Por ejemplo: "¿Cuál es el antídoto del paracetamol?"' }, answer: { type: Type.STRING, description: 'La respuesta a la pregunta. Por ejemplo: "N-acetilcisteína."' } }, required: ['question', 'answer'] } };
const provideContextFunctionDeclaration: FunctionDeclaration = { name: 'provideContext', parameters: { type: Type.OBJECT, description: 'Usa esta función para proporcionar una breve explicación de un concepto o tema importante que se menciona en la conversación.', properties: { topic: { type: Type.STRING, description: 'El tema o concepto a explicar. Por ejemplo: "Taponamiento cardíaco".' }, explanation: { type: Type.STRING, description: 'Una explicación concisa y clara del tema. Por ejemplo: "Es una compresión del corazón causada por la acumulación de líquido en el saco pericárdico, lo que lleva a una disminución del llenado ventricular y del gasto cardíaco."' } }, required: ['topic', 'explanation'] } };

const App: React.FC = () => {
    const [isListening, setIsListening] = useState(false);
    const [transcription, setTranscription] = useState<string>('');
    const [notes, setNotes] = useState<Note[]>([]);
    const [timeLeft, setTimeLeft] = useState(MAX_SESSION_TIME_SECONDS);
    const [error, setError] = useState<string | null>(null);
    const [activeAiResponse, setActiveAiResponse] = useState<Note | null>(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({});
    const [isGeneratingReport, setIsGeneratingReport] = useState(false);
    const [sessionHistory, setSessionHistory] = useState<SessionRecord[]>([]);
    const [viewingSession, setViewingSession] = useState<SessionRecord | null>(null);
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [activeHistoryTab, setActiveHistoryTab] = useState<'report' | 'transcription' | 'qa' | 'notes'>('report');
    
    // Settings State
    const [isVoiceResponseEnabled, setIsVoiceResponseEnabled] = useState(false);
    const [isContextualizeEnabled, setIsContextualizeEnabled] = useState(true);
    const [speechRate, setSpeechRate] = useState(1.3);
    const [selectedVoiceURI, setSelectedVoiceURI] = useState<string | undefined>(undefined);
    const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);

    const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const timerIntervalRef = useRef<number | null>(null);
    
    useEffect(() => {
        const loadVoices = () => {
            const spanishVoices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('es-')).sort((a,b) => a.name.includes('Google') ? -1 : b.name.includes('Google') ? 1: 0);
            setAvailableVoices(spanishVoices);
            if (spanishVoices.length > 0 && !selectedVoiceURI) setSelectedVoiceURI(spanishVoices[0].voiceURI);
        };
        window.speechSynthesis.onvoiceschanged = loadVoices;
        loadVoices();
    }, [selectedVoiceURI]);
    
    useEffect(() => {
        try {
            const savedHistory = localStorage.getItem('asclepio_session_history');
            if (savedHistory) setSessionHistory(JSON.parse(savedHistory));
        } catch (e) { console.error("Failed to load session history:", e); }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem('asclepio_session_history', JSON.stringify(sessionHistory));
        } catch (e) { console.error("Failed to save session history:", e); }
    }, [sessionHistory]);

    const speak = useCallback((text: string) => {
        if (!isVoiceResponseEnabled) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'es-ES';
        utterance.rate = speechRate;
        const selectedVoice = availableVoices.find(voice => voice.voiceURI === selectedVoiceURI);
        if (selectedVoice) utterance.voice = selectedVoice;
        window.speechSynthesis.speak(utterance);
    }, [isVoiceResponseEnabled, speechRate, selectedVoiceURI, availableVoices]);

    const generateSessionReportAndTitle = async (finalTranscription: string, finalNotes: Note[]) => {
        if (!finalTranscription.trim()) return { title: `Sesión del ${new Date().toLocaleString()}`, report: "No se grabó ninguna transcripción." };
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
        try {
            const prompt = `Basado en la siguiente transcripción y notas de una clase o reunión, genera un título conciso (máximo 10 palabras) y un informe completo en formato Markdown. El informe debe estructurar la información clave, los conceptos principales discutidos, las preguntas respondidas y las tareas o puntos importantes a recordar.\n\nTranscripción:\n"${finalTranscription}"\n\nNotas Tomadas:\n${finalNotes.map(n => `- ${n.type === 'qa' ? `P: ${n.question} R: ${n.content}` : n.content}`).join('\n')}`;
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: { type: Type.OBJECT, properties: { title: { type: Type.STRING }, report: { type: Type.STRING } } }
                },
            });
            const result = JSON.parse(response.text);
            return { title: result.title || `Sesión del ${new Date().toLocaleString()}`, report: result.report || "No se pudo generar el informe." };
        } catch (err) {
            console.error("Error generating report:", err);
            return { title: `Sesión del ${new Date().toLocaleString()} (Error)`, report: "Ocurrió un error al generar el informe de la sesión." };
        }
    };
    
    const stopSession = useCallback(async () => {
        if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
        await sessionPromiseRef.current?.then((session) => session.close());
        scriptProcessorRef.current?.disconnect();
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        await audioContextRef.current?.close();
        window.speechSynthesis.cancel();
    
        setIsGeneratingReport(true);
        const finalTranscription = transcription;
        const finalNotes = activeAiResponse ? [...notes, activeAiResponse] : notes;

        const { title, report } = await generateSessionReportAndTitle(finalTranscription, finalNotes);
        const newRecord: SessionRecord = { id: crypto.randomUUID(), title, date: Date.now(), transcription: finalTranscription, notes: finalNotes, report };
        setSessionHistory(prev => [newRecord, ...prev]);

        // Reset state for next session
        timerIntervalRef.current = null; sessionPromiseRef.current = null; scriptProcessorRef.current = null; mediaStreamRef.current = null; audioContextRef.current = null;
        setIsListening(false);
        setIsGeneratingReport(false);
        setTranscription('');
        setNotes([]);
        setActiveAiResponse(null);
    }, [transcription, notes, activeAiResponse]);
    
    useEffect(() => { if (isListening && timeLeft <= 0) stopSession(); }, [isListening, timeLeft, stopSession]);

    const startSession = useCallback(async () => {
        setError(null); setTranscription(''); setNotes([]); setActiveAiResponse(null); setTimeLeft(MAX_SESSION_TIME_SECONDS); setIsListening(true); setViewingSession(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

            const onMessage = (message: LiveServerMessage) => {
                if (message.serverContent?.inputTranscription) setTranscription(prev => prev + message.serverContent.inputTranscription.text);
                if (message.serverContent?.turnComplete) setTranscription(prev => prev + ' ');
                
                if (message.toolCall?.functionCalls) {
                    for (const fc of message.toolCall.functionCalls) {
                        if (fc.name === 'addNote' && fc.args.tip) {
                            const newNote: Note = { id: crypto.randomUUID(), type: 'tip', content: fc.args.tip };
                            setNotes(prev => [...prev, newNote]); speak(`Nota añadida: ${newNote.content}`);
                        } else if (fc.name === 'answerQuestion' && fc.args.question && fc.args.answer) {
                            const newNote: Note = { id: crypto.randomUUID(), type: 'qa', question: fc.args.question, content: fc.args.answer };
                            setActiveAiResponse(newNote); speak(newNote.content);
                        } else if (fc.name === 'provideContext' && fc.args.topic && fc.args.explanation) {
                            const newNote: Note = { id: crypto.randomUUID(), type: 'context', topic: fc.args.topic, content: fc.args.explanation };
                            setActiveAiResponse(newNote); speak(`${newNote.topic}: ${newNote.content}`);
                        }
                    }
                }
            };
            const onError = (e: ErrorEvent) => { console.error('Error de sesión:', e); setError('Ocurrió un error con la sesión.'); stopSession(); };
            const tools = [{ functionDeclarations: [addNoteFunctionDeclaration, answerQuestionFunctionDeclaration] }];
            if (isContextualizeEnabled) tools[0].functionDeclarations.push(provideContextFunctionDeclaration);
            
            sessionPromiseRef.current = ai.live.connect({ model: 'gemini-2.5-flash-native-audio-preview-09-2025', callbacks: { onopen: () => {}, onmessage: onMessage, onerror: onError, onclose: () => {} }, config: { responseModalities: [Modality.AUDIO], inputAudioTranscription: {}, tools, systemInstruction: `Eres Asclepio... Tu única salida debe ser a través de las llamadas a funciones. La velocidad y la relevancia son clave.` } });

            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            const source = audioContextRef.current.createMediaStreamSource(stream);
            scriptProcessorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current.onaudioprocess = (e) => { sessionPromiseRef.current?.then((s) => s.sendRealtimeInput({ media: createPcmBlob(e.inputBuffer.getChannelData(0)) })); };
            source.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(audioContextRef.current.destination);
            timerIntervalRef.current = window.setInterval(() => setTimeLeft(prev => prev - 1), 1000);
        } catch (err) { console.error(err); setError('No se pudo acceder al micrófono.'); setIsListening(false); }
    }, [stopSession, speak, isContextualizeEnabled]);

    const formatTime = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    const handleArchiveNote = () => { if (activeAiResponse) { setNotes(prev => [...prev, activeAiResponse]); setActiveAiResponse(null); } };
    const handleViewSession = (session: SessionRecord) => { setViewingSession(session); setIsSidebarOpen(false); setActiveHistoryTab('report'); };

    const renderNote = (note: Note, isArchived = false) => {
        const icons = { tip: <LightbulbIcon className="w-5 h-5"/>, qa: <QuestionIcon className="w-5 h-5"/>, context: <InfoIcon className="w-5 h-5"/> };
        const colors = { tip: 'bg-amber-100 text-amber-500', qa: 'bg-sky-100 text-sky-500', context: 'bg-indigo-100 text-indigo-500' };
        const shouldBeExpandable = isArchived && (note.type === 'qa' || note.type === 'context');
        
        return (
            <div key={note.id} className="bg-white p-4 rounded-lg shadow-md border border-slate-200 animate-fade-in">
                <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 w-8 h-8 rounded-full ${colors[note.type]} flex items-center justify-center mt-1`}>{icons[note.type]}</div>
                    <div className="flex-grow">
                        {note.type === 'tip' && <p className="text-slate-700">{note.content}</p>}
                        {note.type === 'context' && <p className="font-semibold text-slate-800">{note.topic}</p>}
                        {note.type === 'qa' && <p className="font-semibold text-slate-800">{note.question}</p>}
                        
                        {shouldBeExpandable ? (
                            <>
                                <button onClick={() => setExpandedNotes(p => ({...p, [note.id]: !p[note.id]}))} className="text-sm text-cyan-600 hover:underline mt-1">
                                    {expandedNotes[note.id] ? 'Ocultar' : 'Mostrar'} {note.type === 'qa' ? 'respuesta' : 'explicación'}
                                </button>
                                {expandedNotes[note.id] && <p className="text-slate-700 mt-2 animate-fade-in">{note.content}</p>}
                            </>
                        ) : note.type !== 'tip' && <p className="text-slate-700 mt-1">{note.content}</p>}
                    </div>
                </div>
            </div>
        );
    };
    
    const liveSessionView = () => (
        <>
            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-4">
                <div className="flex items-center gap-3"><div className={`w-4 h-4 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-slate-400'}`}></div><span className="font-semibold text-lg">{isListening ? 'Sesión en Progreso' : 'Listo para Empezar'}</span></div>
                <div className="flex items-center gap-4">
                    <div className="text-2xl font-mono bg-slate-100 px-4 py-2 rounded-lg text-slate-700">{formatTime(timeLeft)}</div>
                    <button onClick={isListening ? stopSession : startSession} className={`flex items-center justify-center w-36 h-12 px-6 py-3 font-semibold text-white rounded-full transition-all duration-300 ease-in-out transform hover:scale-105 ${isListening ? 'bg-red-500 hover:bg-red-600' : 'bg-cyan-500 hover:bg-cyan-600'}`} disabled={isGeneratingReport}>
                        {isListening ? <><StopIcon className="w-6 h-6 mr-2" />Detener</> : <><MicrophoneIcon className="w-6 h-6 mr-2" />Iniciar</>}
                    </button>
                </div>
            </div>

            {isGeneratingReport && <div className="bg-white p-6 rounded-xl shadow-md border text-center"><p className="font-semibold text-cyan-700">Generando informe de la sesión, por favor espera...</p></div>}
            {error && <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 rounded-md" role="alert"><p>{error}</p></div>}
            
            {isListening || notes.length > 0 || transcription || activeAiResponse ? (
                <>
                    <div className="bg-white rounded-xl shadow-md border border-slate-200 p-4"><p className="text-slate-600 min-h-[100px] max-h-[200px] overflow-y-auto text-justify leading-relaxed">{transcription || <span className="text-slate-400">Esperando audio...</span>}</p></div>
                    <div className="space-y-4">
                        <h2 className="text-xl font-semibold text-slate-700">Notas y Respuestas de IA</h2>
                        {activeAiResponse && <div className="bg-white p-6 rounded-xl shadow-lg border-2 border-cyan-400 animate-fade-in-down"><div className="flex items-start gap-3"><div className={`flex-shrink-0 w-8 h-8 rounded-full ${activeAiResponse.type === 'qa' ? 'bg-sky-100 text-sky-500' : 'bg-indigo-100 text-indigo-500'} flex items-center justify-center mt-1`}>{activeAiResponse.type === 'qa' ? <QuestionIcon className="w-5 h-5"/> : <InfoIcon className="w-5 h-5"/>}</div><h3 className="flex-grow text-xl font-bold text-slate-800">{activeAiResponse.type === 'qa' ? activeAiResponse.question : activeAiResponse.topic}</h3></div><p className="text-lg text-slate-700 leading-relaxed my-4 pl-11">{activeAiResponse.content}</p><button onClick={handleArchiveNote} className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 font-semibold rounded-lg transition-colors"><ArchiveIcon className="w-5 h-5"/>Archivar Respuesta</button></div>}
                        {notes.length === 0 && !activeAiResponse && isListening && <p className="text-slate-500 text-center py-4">Escuchando puntos clave y preguntas...</p>}
                        {notes.map(note => renderNote(note))}
                    </div>
                </>
            ) : !isGeneratingReport && <div className="text-center p-10 bg-white rounded-xl shadow-md border border-slate-200"><h2 className="text-xl font-semibold text-slate-700">Bienvenido a Asclepio Class</h2><p className="text-slate-500 mt-2">Haz clic en "Iniciar" para comenzar una nueva sesión. Tu asistente transcribirá, extraerá notas y responderá preguntas en tiempo real.</p></div>}
        </>
    );

    const sessionHistoryView = () => {
        if (!viewingSession) return null;
        const tabs = { report: 'Informe Completo', transcription: 'Transcripción', qa: 'Preguntas y Respuestas', notes: 'Notas Clave' };
        const filteredQA = viewingSession.notes.filter(n => n.type === 'qa');
        const filteredNotes = viewingSession.notes.filter(n => n.type === 'tip' || n.type === 'context');
        
        return (
            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200 w-full animate-fade-in">
                <h2 className="text-2xl font-bold text-slate-800">{viewingSession.title}</h2>
                <p className="text-sm text-slate-500 mb-4">{new Date(viewingSession.date).toLocaleString()}</p>
                <div className="border-b border-slate-200 mb-4">
                    <nav className="-mb-px flex space-x-6">
                        {Object.entries(tabs).map(([key, value]) => (
                             <button key={key} onClick={() => setActiveHistoryTab(key as any)} className={`whitespace-nowrap py-3 px-1 border-b-2 font-medium text-sm ${activeHistoryTab === key ? 'border-cyan-500 text-cyan-600' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'}`}>{value}</button>
                        ))}
                    </nav>
                </div>
                <div className="max-h-[60vh] overflow-y-auto pr-2">
                    {activeHistoryTab === 'report' && <div className="prose prose-slate max-w-none" dangerouslySetInnerHTML={{ __html: viewingSession.report.replace(/\n/g, '<br />') }}></div>}
                    {activeHistoryTab === 'transcription' && <p className="text-slate-700 leading-relaxed whitespace-pre-wrap">{viewingSession.transcription}</p>}
                    {activeHistoryTab === 'qa' && <div className="space-y-3">{filteredQA.length > 0 ? filteredQA.map(note => renderNote(note, true)) : <p className="text-slate-500">No se hicieron preguntas en esta sesión.</p>}</div>}
                    {activeHistoryTab === 'notes' && <div className="space-y-3">{filteredNotes.length > 0 ? filteredNotes.map(note => renderNote(note, true)) : <p className="text-slate-500">No se tomaron notas clave en esta sesión.</p>}</div>}
                </div>
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-slate-50 text-slate-800 font-sans flex flex-col items-center p-4 sm:p-6 lg:p-8">
            <header className="w-full max-w-4xl mb-6 flex justify-between items-center">
                <button onClick={() => setIsSidebarOpen(true)} className="text-slate-500 hover:text-cyan-600 transition-colors" aria-label="Abrir historial"><HistoryIcon className="w-7 h-7"/></button>
                <div className="flex flex-col items-center">
                    <h1 className="text-3xl sm:text-4xl font-bold text-cyan-700 tracking-wide">ASCLEPIO CLASS</h1>
                    <p className="text-slate-500 mt-2">Tu asistente de IA futurista para clases y reuniones.</p>
                </div>
                <div className="w-14 flex justify-end">
                    {viewingSession ? <button onClick={() => setViewingSession(null)} className="bg-cyan-500 text-white font-semibold py-2 px-4 rounded-lg text-sm hover:bg-cyan-600 transition-colors">Nueva Sesión</button> : <button onClick={() => setIsSettingsOpen(true)} className="text-slate-500 hover:text-cyan-600 transition-colors" aria-label="Abrir ajustes"><CogIcon className="w-7 h-7"/></button>}
                </div>
            </header>

            <main className="w-full max-w-4xl flex flex-col gap-6">{viewingSession ? sessionHistoryView() : liveSessionView()}</main>

            {isSidebarOpen && (
                <div className="fixed inset-0 z-40">
                    <div className="absolute inset-0 bg-black bg-opacity-50" onClick={() => setIsSidebarOpen(false)}></div>
                    <div className="relative z-50 w-80 max-w-[90vw] h-full bg-white shadow-xl flex flex-col p-4">
                        <div className="flex justify-between items-center border-b pb-3 mb-3"><h3 className="text-lg font-semibold">Historial de Sesiones</h3><button onClick={() => setIsSidebarOpen(false)}><CloseIcon className="w-6 h-6"/></button></div>
                        <div className="flex-grow overflow-y-auto">
                            {sessionHistory.length === 0 && <p className="text-slate-500 text-sm">No hay sesiones guardadas.</p>}
                            <ul className="space-y-2">
                                {sessionHistory.map(session => (
                                    <li key={session.id}><button onClick={() => handleViewSession(session)} className="w-full text-left p-3 rounded-lg hover:bg-slate-100 transition-colors"><span className="font-semibold block text-slate-800">{session.title}</span><span className="text-xs text-slate-500">{new Date(session.date).toLocaleString()}</span></button></li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            )}
            
            {isSettingsOpen && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50" onClick={() => setIsSettingsOpen(false)}>
                    <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md m-4 space-y-4" onClick={e => e.stopPropagation()}>
                        <h3 className="text-xl font-semibold text-slate-800 border-b pb-3">Ajustes</h3>
                        <div className="flex justify-between items-center py-2"><label htmlFor="context-toggle" className="font-medium text-slate-700">Contextualizar en Vivo</label><button id="context-toggle" onClick={() => setIsContextualizeEnabled(!isContextualizeEnabled)} className={`relative inline-flex items-center h-6 rounded-full w-11 transition-colors ${isContextualizeEnabled ? 'bg-cyan-500' : 'bg-slate-300'}`} disabled={isListening}><span className={`inline-block w-4 h-4 transform bg-white rounded-full transition-transform ${isContextualizeEnabled ? 'translate-x-6' : 'translate-x-1'}`}/></button></div>
                        <p className="text-sm text-slate-500 -mt-3">La IA explica proactivamente los temas clave. {isListening && "(Bloqueado durante sesión)"}</p>
                        <div className="border-t pt-4 space-y-2"><div className="flex justify-between items-center"><label htmlFor="voice-toggle" className="font-medium text-slate-700">Respuestas de Voz</label><button id="voice-toggle" onClick={() => setIsVoiceResponseEnabled(!isVoiceResponseEnabled)} className={`relative inline-flex items-center h-6 rounded-full w-11 transition-colors ${isVoiceResponseEnabled ? 'bg-cyan-500' : 'bg-slate-300'}`}><span className={`inline-block w-4 h-4 transform bg-white rounded-full transition-transform ${isVoiceResponseEnabled ? 'translate-x-6' : 'translate-x-1'}`}/></button></div><p className="text-sm text-slate-500">Lee las notas y respuestas de la IA en voz alta.</p></div>
                        {isVoiceResponseEnabled && <div className="space-y-4 pt-2 animate-fade-in"><div><label htmlFor="voice-select" className="block text-sm font-medium text-slate-600 mb-1">Voz</label><select id="voice-select" value={selectedVoiceURI} onChange={(e) => setSelectedVoiceURI(e.target.value)} className="w-full p-2 border border-slate-300 rounded-md bg-white shadow-sm focus:ring-cyan-500 focus:border-cyan-500">{availableVoices.map(voice => <option key={voice.voiceURI} value={voice.voiceURI}>{voice.name} ({voice.lang})</option>)}</select></div><div><label htmlFor="rate-slider" className="block text-sm font-medium text-slate-600 mb-1">Velocidad de Lectura: <span className="font-bold">{speechRate.toFixed(1)}x</span></label><input id="rate-slider" type="range" min="0.5" max="2" step="0.1" value={speechRate} onChange={(e) => setSpeechRate(parseFloat(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-cyan-600" /></div></div>}
                        <button onClick={() => setIsSettingsOpen(false)} className="mt-4 w-full bg-cyan-500 text-white font-bold py-2 px-4 rounded-lg hover:bg-cyan-600 transition-colors">Cerrar</button>
                    </div>
                </div>
            )}

             <style>{`
                @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
                .animate-fade-in { animation: fade-in 0.5s ease-out forwards; }
                @keyframes fade-in-down { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
                .animate-fade-in-down { animation: fade-in-down 0.5s ease-out forwards; }
                .prose { line-height: 1.7; }
                .prose h1, .prose h2, .prose h3 { font-weight: 700; margin-top: 1.5em; margin-bottom: 0.5em; }
                .prose ul { list-style-type: disc; padding-left: 1.5em; }
                .prose strong { font-weight: 600; }
             `}</style>
        </div>
    );
};

export default App;
