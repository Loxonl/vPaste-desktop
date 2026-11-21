import AppKit

@MainActor
final class PanelEmojiPicker: NSViewController, NSSearchFieldDelegate {
  private let emojis: [String]
  private let selected: String
  private let chinese: Bool
  private let choose: (String) -> Void
  private let dismiss: () -> Void
  private let search = NSSearchField()
  private let scroll = NSScrollView()
  private let grid = FlippedView()
  private let clear = ChoiceButton()
  private let noResults = NSTextField(labelWithString: "")
  private let cell: CGFloat = 32
  private let columns = 8
  private var displayed: [String] = []

  init(emojis: [String], selected: String, chinese: Bool, choose: @escaping (String) -> Void,
    dismiss: @escaping () -> Void) {
    self.emojis = emojis
    self.selected = selected
    self.chinese = chinese
    self.choose = choose
    self.dismiss = dismiss
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func loadView() {
    // Keep the search and clear action visible while the eight-column grid scrolls.
    let root = NSView(frame: NSRect(x: 0, y: 0, width: 288, height: 302))
    view = root
    search.frame = NSRect(x: 12, y: 266, width: 264, height: 24)
    let searchTitle = local("Search icons", "搜索图标")
    search.placeholderString = searchTitle
    search.setAccessibilityLabel(searchTitle)
    search.delegate = self
    root.addSubview(search)

    clear.frame = NSRect(x: 12, y: 232, width: 264, height: 28)
    clear.title = local("No emoji", "不使用图标")
    clear.alignment = .left
    configure(clear, selected: selected.isEmpty)
    clear.action = #selector(clearSelection)
    root.addSubview(clear)

    scroll.frame = NSRect(x: 12, y: 10, width: 264, height: 216)
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = true
    scroll.autohidesScrollers = true
    scroll.scrollerStyle = .overlay
    scroll.documentView = grid
    root.addSubview(scroll)
    noResults.frame = NSRect(x: 12, y: 190, width: 264, height: 24)
    noResults.alignment = .center
    noResults.textColor = .secondaryLabelColor
    noResults.stringValue = local("No matching icons", "没有匹配的图标")
    root.addSubview(noResults)
    reload(query: "")
  }

  override func viewDidAppear() {
    super.viewDidAppear()
    view.window?.makeFirstResponder(search)
  }

  override func cancelOperation(_ sender: Any?) { dismiss() }

  func controlTextDidChange(_ notification: Notification) {
    guard notification.object as? NSSearchField === search else { return }
    reload(query: search.currentEditor()?.string ?? search.stringValue)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    guard !textView.hasMarkedText() else { return false }
    switch selector {
    case #selector(cancelOperation(_:)): dismiss()
    case #selector(insertTab(_:)): view.window?.makeFirstResponder(clear)
    case #selector(insertBacktab(_:)): view.window?.makeFirstResponder(grid.subviews.last ?? clear)
    default: return false
    }
    return true
  }

  private func reload(query: String) {
    displayed = Self.matches(emojis, query: query)
    grid.subviews.forEach { $0.removeFromSuperview() }
    let rows = (displayed.count + columns - 1) / columns
    grid.frame = NSRect(x: 0, y: 0, width: CGFloat(columns) * cell, height: CGFloat(rows) * cell)
    let buttons = displayed.enumerated().map { index, emoji in
      makeIcon(emoji, index: index)
    }
    buttons.forEach { grid.addSubview($0) }
    let keyViews = [search, clear] as [NSView] + buttons
    for (index, current) in keyViews.enumerated() {
      let next = keyViews[(index + 1) % keyViews.count]
      current.nextKeyView = next
      if let button = current as? ChoiceButton {
        button.previousChoice = keyViews[(index + keyViews.count - 1) % keyViews.count]
      }
    }
    noResults.isHidden = !displayed.isEmpty
    scroll.contentView.scroll(to: .zero)
    scroll.reflectScrolledClipView(scroll.contentView)
  }

  private func makeIcon(_ emoji: String, index: Int) -> NSButton {
    let button = ChoiceButton(frame: NSRect(x: CGFloat(index % columns) * cell + 1,
      y: CGFloat(index / columns) * cell + 1, width: cell - 2, height: cell - 2))
    button.title = emoji
    button.font = .systemFont(ofSize: 17)
    let name = Self.names[emoji]?.label(chinese: chinese) ?? emoji
    button.toolTip = name
    button.setAccessibilityLabel(name)
    button.tag = index
    configure(button, selected: emoji == selected)
    button.action = #selector(selectIcon(_:))
    return button
  }

  private func configure(_ button: NSButton, selected: Bool) {
    button.bezelStyle = .regularSquare
    button.setButtonType(.pushOnPushOff)
    button.state = selected ? .on : .off
    button.target = self
  }

  @objc private func selectIcon(_ sender: NSButton) {
    guard displayed.indices.contains(sender.tag) else { return }
    choose(displayed[sender.tag])
  }

  @objc private func clearSelection() { choose("") }

  private func local(_ english: String, _ chinese: String) -> String {
    self.chinese ? chinese : english
  }

  static func matches(_ emojis: [String], query: String) -> [String] {
    let tokens = query.split(whereSeparator: \.isWhitespace)
    guard !tokens.isEmpty else { return emojis }
    return emojis.filter { emoji in
      let keywords = names[emoji].map { "\($0.english) \($0.chinese)" } ?? ""
      let text = "\(emoji) \(keywords)"
      return tokens.allSatisfy { text.range(of: String($0), options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
  }

  private final class ChoiceButton: NSButton {
    weak var previousChoice: NSView?
    override var acceptsFirstResponder: Bool { isEnabled }

    override func becomeFirstResponder() -> Bool {
      guard super.becomeFirstResponder() else { return false }
      scrollToVisible(bounds)
      return true
    }

    override func keyDown(with event: NSEvent) {
      let modifiers = event.modifierFlags.intersection([.shift, .command, .control, .option])
      if event.keyCode == 48, modifiers.isEmpty || modifiers == .shift {
        window?.makeFirstResponder(modifiers == .shift ? previousChoice : nextKeyView)
      } else {
        super.keyDown(with: event)
      }
    }
  }

  private final class FlippedView: NSView { override var isFlipped: Bool { true } }

  private struct Name {
    let english: String
    let chinese: String
    func label(chinese: Bool) -> String { chinese ? self.chinese : english }
  }

  // Search labels are keyed by glyph; the shared catalog still controls membership and order.
  private static let names: [String: Name] = Dictionary(uniqueKeysWithValues: """
    📝|Memo note|备忘录 笔记
    📄|Document page|文档 页面
    📋|Clipboard|剪贴板
    📌|Push pin|图钉 置顶
    📁|Folder|文件夹
    📂|Open folder|打开的文件夹
    🗂️|Card dividers|索引 分隔卡
    📦|Package box|包裹 盒子
    🔗|Link chain|链接 链条
    🌐|Globe web|地球 网络
    🎨|Artist palette|调色板 绘画
    🌈|Rainbow|彩虹
    🖼️|Framed picture image|相框 图片
    📷|Camera photo|相机 照片
    ⭐|Star favorite|星星 收藏
    ❤️|Red heart love|红心 爱心
    💬|Speech bubble chat|对话 气泡
    💡|Light bulb idea|灯泡 灵感
    ✅|Check mark button|勾选 完成
    ☑️|Checkbox|复选框 勾选
    ⚠️|Warning|警告
    🔒|Lock|锁
    🔧|Wrench|扳手
    ⚙️|Gear settings|齿轮 设置
    🧩|Puzzle piece|拼图
    🔍|Magnifying glass search|放大镜 搜索
    📊|Bar chart|柱状图
    📈|Chart rising growth|走势图 上升
    📉|Chart falling decline|走势图 下降
    🗒️|Spiral notepad|记事本 笔记
    📚|Books|书籍
    📖|Open book|打开的书
    ✏️|Pencil|铅笔
    🖊️|Pen|笔 签字笔
    🗃️|Card file box|卡片档案盒
    🧾|Receipt|收据 小票
    🗓️|Calendar|日历
    ⏰|Alarm clock|闹钟
    🚀|Rocket|火箭
    🔥|Fire flame|火焰
    ✨|Sparkles|闪光 闪亮
    🎯|Target bullseye|靶心 目标
    🏷️|Label tag|标签
    🔖|Bookmark|书签
    📎|Paper clip|回形针
    🧷|Safety pin|别针
    🗝️|Key|钥匙
    🛠️|Hammer and wrench tools|锤子 扳手 工具
    💻|Laptop computer|笔记本电脑
    ⌨️|Keyboard|键盘
    🖥️|Desktop computer monitor|台式电脑 显示器
    📱|Mobile phone|手机
    🧠|Brain|大脑
    🧪|Test tube|试管
    🔬|Microscope|显微镜
    📐|Triangular ruler|三角尺
    📏|Straight ruler|直尺
    🧰|Toolbox|工具箱
    🛡️|Shield|盾牌
    🔔|Bell notification|铃铛 通知
    📣|Megaphone|喇叭 扩音器
    🎵|Music note|音乐 音符
    🎬|Clapper board movie|场记板 电影
    🎮|Video game controller|游戏 手柄
    🏠|House home|房子 家
    🏢|Office building|写字楼 办公楼
    💼|Briefcase|公文包
    💰|Money bag|钱袋
    🛒|Shopping cart|购物车
    🎁|Gift present|礼物
    ☕|Coffee hot drink|咖啡 热饮
    🍀|Four leaf clover|四叶草 幸运
    🌟|Glowing star|闪亮的星星
    🌙|Crescent moon|月亮 月牙
    ☀️|Sun|太阳 晴天
    ⛅|Sun behind cloud|多云
    🌧️|Rain cloud|下雨 雨云
    ❄️|Snowflake|雪花
    🍎|Red apple|红苹果
    🍕|Pizza|披萨
    😀|Grinning face|笑脸
    😄|Laughing face|开心 大笑
    😊|Smiling face|微笑
    😍|Heart eyes|爱心眼 喜欢
    🤔|Thinking face|思考
    😎|Sunglasses cool|墨镜 酷
    👍|Thumbs up|点赞 拇指向上
    👎|Thumbs down|反对 拇指向下
    👏|Clapping hands|鼓掌
    🙏|Folded hands|祈祷 感谢
    🙌|Raised hands|举手 欢呼
    💪|Flexed biceps muscle|肌肉 强壮
    👀|Eyes|眼睛
    🎉|Party popper confetti|礼花 庆祝
    🥳|Partying face|派对 庆祝
    💯|Hundred points 100|一百分 满分
    0️⃣|Zero 0|零
    1️⃣|One 1|一
    2️⃣|Two 2|二
    3️⃣|Three 3|三
    4️⃣|Four 4|四
    5️⃣|Five 5|五
    6️⃣|Six 6|六
    7️⃣|Seven 7|七
    8️⃣|Eight 8|八
    9️⃣|Nine 9|九
    🔟|Ten 10|十
    #️⃣|Hash number sign|井号
    *️⃣|Asterisk star|星号
    🅰️|A button blood type|A 型血
    🅱️|B button blood type|B 型血
    🆕|New button|新
    """.split(separator: "\n").map {
      let fields = $0.split(separator: "|")
      return (String(fields[0]), Name(english: String(fields[1]), chinese: String(fields[2])))
    })
}
