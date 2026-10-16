import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { ReviewDesk } from './review-desk';
import './review-selected.css';
import './review-annotations.css';
import './review-flow.css';
import './components/frame-comment.css';
import 'lenis/dist/lenis.css';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#b95337',
          colorInfo: '#b95337',
          colorBgBase: '#fffdf7',
          colorTextBase: '#30342d',
          borderRadius: 6,
          fontFamily: 'MiSans, sans-serif',
          fontSize: 15,
          controlHeight: 40,
        },
      }}
    >
      <AntApp message={{ maxCount: 1 }}>
        <ReviewDesk />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
