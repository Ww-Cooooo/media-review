import { Button } from 'antd';
import { ArrowRightOutlined, AudioOutlined, SafetyCertificateOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { ReviewHistory } from './ReviewHistory';

export function ReviewHome({ onOpen, onResume, hasMedia, online }: { onOpen: (kind: 'video' | 'audio') => void; onResume: () => void; hasMedia: boolean; online: boolean }) {
  return <main className="home">
    <div className="home-a"><section>
      <div className="eyebrow">看画面 · 听声音 · 留意见</div>
      <h1>问题在哪儿，<br />就把意见<em>留在哪儿。</em></h1>
      <p className="lead">不必学会剪辑器。打开一段视频或录音，圈出画面、<span className="keep-term">选中时间段</span>，把你的想法留在准确的位置。</p>
      <div className="file-pair">{(['video', 'audio'] as const).map(kind => <Button key={kind} className="file-choice" type="text" onClick={() => onOpen(kind)}>
        <span className={`file-face ${kind}-file`}>{kind === 'video' ? <VideoCameraOutlined /> : <AudioOutlined />}<span>本机{kind === 'video' ? '视频' : '音频'}</span></span>
        <span className={`file-pick ${kind === 'video' ? 'primary' : ''}`}>选择{kind === 'video' ? '视频' : '音频'} <ArrowRightOutlined /></span>
      </Button>)}</div>
      <p className="format-line">选本机文件，给时间点、时间段或画面位置留意见{hasMedia && <> · <Button type="link" onClick={onResume}>返回正在审阅的素材</Button></>}</p>
      <div className="home-steps">{[
        ['先看，或者先听', '打开视频或录音，找到想说的位置。'],
        ['圈画面，选一段', '按钮就在画面和时间轴旁边。'],
        ['写意见，交给 Agent', '保留准确位置，保存后复制交接内容。'],
      ].map(([title, text], index) => <div className="home-step" key={title}><span>0{index + 1}</span><strong>{title}</strong><p>{text}</p></div>)}</div>
    </section><ReviewHistory online={online} /></div>
    <footer className="home-foot"><span><SafetyCertificateOutlined />原素材只读 · 本机分析</span><span>意见保存后，再交给 Agent 处理</span><a href="/licenses/MiSans-License.pdf" target="_blank" rel="noopener">字体 MiSans · © Xiaomi</a></footer>
  </main>;
}
