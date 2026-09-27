/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Preference row component
 * Displays a label and control in a unified horizontal layout
 */
const PreferenceRow: React.FC<{
  label: string;
  children: React.ReactNode;
  description?: string;
}> = ({ label, children, description }) => (
  <div className='flex items-center justify-between gap-24px py-12px'>
    <div className='flex-1'>
      {/* 标签用 text-t-primary（--text-primary，#000）：与 Tools/Model/Appearance 等
          设置页的 text-14px text-t-primary 标签一致；text-2 是 Arco 灰阶，会显得发灰 */}
      <div className='text-14px text-t-primary'>{label}</div>
      {description && <div className='text-12px text-t-tertiary mt-4px'>{description}</div>}
    </div>
    <div className='flex-shrink-0'>{children}</div>
  </div>
);

export default PreferenceRow;
