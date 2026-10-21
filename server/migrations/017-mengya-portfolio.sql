INSERT OR IGNORE INTO users(id, github_id, email, github_username, full_name, avatar_url)
VALUES(
  'system-mengya-portfolio',
  'system:mengya-portfolio',
  '',
  'mengya-portfolio',
  '萌芽作品集',
  '/images/rd-studio-logo.png'
);

INSERT OR IGNORE INTO profiles(id, username, full_name, avatar_url, bio, role, is_super_admin, badge_text, badge_color)
VALUES(
  'system-mengya-portfolio',
  '萌芽作品集',
  '萌芽作品集',
  '/images/rd-studio-logo.png',
  'RD STUDIO 萌芽作品集 · 官方精选游戏与作品专区',
  'member',
  0,
  '官方展区',
  '#10b981'
);
