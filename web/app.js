/**
 * Mini Bank - Frontend Logic (web/app.js)
 *
 * Tiêu chuẩn kỹ thuật:
 * - JavaScript thuần (Vanilla JS), không framework, không CDN.
 * - Gọi API bằng đường dẫn tương đối (/api/auth, /api/accounts, /api/transactions).
 * - Lưu JWT trong sessionStorage; nhận 401 thì xóa phiên và quay lại đăng nhập.
 * - BẢO MẬT TUYỆT ĐỐI: hiển thị dữ liệu từ API và người dùng bằng textContent,
 *   KHÔNG dùng innerHTML với dữ liệu động để phòng chống XSS.
 * - Tiền tệ định dạng vi-VN (ví dụ: 10.250.000 ₫).
 * - Idempotency tự động retry tối đa 3 lần cách nhau 2s khi gặp 503 hoặc 409 REQUEST_IN_PROGRESS.
 */

(function () {
  'use strict';

  // --- 1. TỪ ĐIỂN THÔNG BÁO LỖI TIẾNG VIỆT DỄ HIỂU ---
  const ERROR_MESSAGES = {
    INSUFFICIENT_FUNDS: 'Số dư không đủ để thực hiện giao dịch',
    DAILY_LIMIT_EXCEEDED: 'Giao dịch vượt quá hạn mức rút/chuyển trong ngày (tối đa 200.000.000 ₫)',
    ACCOUNT_NOT_ACTIVE: 'Tài khoản đang bị đóng băng hoặc đã đóng, không thể giao dịch',
    ACCOUNT_LIMIT_REACHED: 'Khách hàng đã đạt tối đa 3 tài khoản đang hoạt động',
    INVALID_AMOUNT: 'Số tiền giao dịch không hợp lệ (từ 1.000 đến 50.000.000 ₫)',
    SAME_ACCOUNT: 'Không thể chuyển tiền cho chính tài khoản nguồn',
    FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này',
    ACCOUNT_NOT_FOUND: 'Không tìm thấy thông tin tài khoản',
    REQUEST_IN_PROGRESS: 'Giao dịch với mã yêu cầu này đang được xử lý, đang thử lại...',
    IDEMPOTENCY_KEY_CONFLICT: 'Khóa giao dịch bị xung đột thông tin hoặc thuộc về người khác',
    IDEMPOTENCY_KEY_REQUIRED: 'Thiếu mã khóa giao dịch Idempotency-Key',
    INVALID_CREDENTIALS: 'Tên đăng nhập hoặc mật khẩu không chính xác',
    USERNAME_TAKEN: 'Tên đăng nhập đã được sử dụng, vui lòng chọn tên khác',
    WEAK_PASSWORD: 'Mật khẩu phải có tối thiểu 8 ký tự',
    INVALID_ID_NUMBER: 'Số CCCD không hợp lệ (phải gồm đúng 12 chữ số)',
    ID_NUMBER_TAKEN: 'Số CCCD này đã được đăng ký bởi khách hàng khác',
    INVALID_DESCRIPTION: 'Nội dung mô tả không được vượt quá 200 ký tự',
    INVALID_ACCOUNT_NUMBER: 'Số tài khoản phải gồm đúng 12 chữ số',
    SERVICE_UNAVAILABLE: 'Dịch vụ tạm thời không khả dụng, vui lòng thử lại sau',
    NETWORK_ERROR: 'Không thể kết nối đến máy chủ, vui lòng kiểm tra kết nối mạng',
    UNBALANCED_POSTING: 'Lỗi hạch toán sổ cái không cân bằng',
  };

  function getFriendlyMessage(err) {
    if (!err) return 'Đã có lỗi xảy ra, vui lòng thử lại';
    if (err.code && ERROR_MESSAGES[err.code]) {
      return ERROR_MESSAGES[err.code];
    }
    return err.message || 'Thao tác không thành công';
  }

  // --- 2. STATE ỨNG DỤNG ---
  const STATE = {
    token: sessionStorage.getItem('mb_token') || null,
    user: JSON.parse(sessionStorage.getItem('mb_user') || 'null'),
    accounts: [],
    currentTab: 'accountsTab',
    history: {
      mode: 'transactions', // 'transactions' | 'postings'
      account: '',
      page: 1,
      size: 10,
    },
    // Quản lý Idempotency riêng cho từng form
    idempotency: {
      transfer: { key: null, isSubmitting: false },
      withdraw: { key: null, isSubmitting: false },
      deposit: { key: null, isSubmitting: false },
    },
    targetStatusAccount: null,
  };

  // --- 3. DOM ELEMENTS ---
  const el = {
    // Header
    userProfile: document.getElementById('userProfile'),
    userNameDisplay: document.getElementById('userNameDisplay'),
    userRoleBadge: document.getElementById('userRoleBadge'),
    logoutBtn: document.getElementById('logoutBtn'),

    // Toast Container
    toastContainer: document.getElementById('toastContainer'),

    // Auth Section
    authSection: document.getElementById('authSection'),
    dashboardSection: document.getElementById('dashboardSection'),
    tabLoginBtn: document.getElementById('tabLoginBtn'),
    tabRegisterBtn: document.getElementById('tabRegisterBtn'),
    loginFormContainer: document.getElementById('loginFormContainer'),
    registerFormContainer: document.getElementById('registerFormContainer'),
    loginForm: document.getElementById('loginForm'),
    registerForm: document.getElementById('registerForm'),
    loginUsername: document.getElementById('loginUsername'),
    loginPassword: document.getElementById('loginPassword'),
    loginSubmitBtn: document.getElementById('loginSubmitBtn'),
    registerSubmitBtn: document.getElementById('registerSubmitBtn'),

    // Dashboard Tabs
    navTabs: document.querySelectorAll('.nav-tab'),
    tabPanes: document.querySelectorAll('.tab-pane'),

    // Accounts Tab
    accountsList: document.getElementById('accountsList'),
    totalBalanceDisplay: document.getElementById('totalBalanceDisplay'),
    accountCountDisplay: document.getElementById('accountCountDisplay'),
    openAccountBtn: document.getElementById('openAccountBtn'),
    refreshAccountsBtn: document.getElementById('refreshAccountsBtn'),

    // Transfer Tab
    transferForm: document.getElementById('transferForm'),
    transferFromAccount: document.getElementById('transferFromAccount'),
    transferToAccount: document.getElementById('transferToAccount'),
    transferAmount: document.getElementById('transferAmount'),
    transferDescription: document.getElementById('transferDescription'),
    transferSubmitBtn: document.getElementById('transferSubmitBtn'),
    transferSourceBalanceHint: document.getElementById('transferSourceBalanceHint'),

    // Withdraw Tab
    withdrawForm: document.getElementById('withdrawForm'),
    withdrawFromAccount: document.getElementById('withdrawFromAccount'),
    withdrawAmount: document.getElementById('withdrawAmount'),
    withdrawDescription: document.getElementById('withdrawDescription'),
    withdrawSubmitBtn: document.getElementById('withdrawSubmitBtn'),
    withdrawSourceBalanceHint: document.getElementById('withdrawSourceBalanceHint'),

    // Deposit Tab (ADMIN)
    depositForm: document.getElementById('depositForm'),
    depositToAccount: document.getElementById('depositToAccount'),
    depositAmount: document.getElementById('depositAmount'),
    depositDescription: document.getElementById('depositDescription'),
    depositSubmitBtn: document.getElementById('depositSubmitBtn'),

    // History Tab
    historyAccountSelect: document.getElementById('historyAccountSelect'),
    viewTransactionsBtn: document.getElementById('viewTransactionsBtn'),
    viewPostingsBtn: document.getElementById('viewPostingsBtn'),
    historyTableHead: document.getElementById('historyTableHead'),
    historyTableBody: document.getElementById('historyTableBody'),
    paginationBar: document.getElementById('paginationBar'),
    prevPageBtn: document.getElementById('prevPageBtn'),
    nextPageBtn: document.getElementById('nextPageBtn'),
    pageIndicator: document.getElementById('pageIndicator'),

    // Modals
    receiptModal: document.getElementById('receiptModal'),
    receiptModalTitle: document.getElementById('receiptModalTitle'),
    receiptModalBody: document.getElementById('receiptModalBody'),
    closeReceiptModalBtn: document.getElementById('closeReceiptModalBtn'),
    receiptDoneBtn: document.getElementById('receiptDoneBtn'),

    statusModal: document.getElementById('statusModal'),
    statusTargetAccountDisplay: document.getElementById('statusTargetAccountDisplay'),
    newStatusSelect: document.getElementById('newStatusSelect'),
    closeStatusModalBtn: document.getElementById('closeStatusModalBtn'),
    cancelStatusBtn: document.getElementById('cancelStatusBtn'),
    submitStatusBtn: document.getElementById('submitStatusBtn'),
  };

  // --- 4. TIỆN ÍCH AN TOÀN DOM (CHỐNG XSS BẰNG TEXTCONTENT) ---

  /**
   * Tạo element an toàn với textContent (không dùng innerHTML cho dữ liệu người dùng)
   */
  function createEl(tag, text, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  /**
   * Xóa toàn bộ con của element
   */
  function clearElement(element) {
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function generateUUID() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Định dạng tiền tệ tiếng Việt theo chuẩn: 10.250.000 ₫
   */
  function formatCurrency(amount) {
    const val = Number(amount) || 0;
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(val);
  }

  function formatDateTime(isoString) {
    if (!isoString) return '—';
    try {
      const d = new Date(isoString);
      return d.toLocaleString('vi-VN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      return String(isoString);
    }
  }

  function showToast(message, type = 'info', duration = 4000) {
    const toast = createEl('div', null, `toast ${type}`);
    const msgSpan = createEl('span', message, 'toast-msg');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = () => toast.remove();

    toast.appendChild(msgSpan);
    toast.appendChild(closeBtn);
    el.toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, duration);
  }

  // --- 5. GỌI API & QUẢN LÝ PHIÊN ---

  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Id': generateUUID(),
      ...(options.headers || {}),
    };

    if (STATE.token) {
      headers['Authorization'] = `Bearer ${STATE.token}`;
    }

    try {
      const res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

      let data = null;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await res.json().catch(() => null);
      }

      // Nhận 401: phiên hết hạn -> xóa token và quay về đăng nhập
      if (res.status === 401) {
        handleLogout(false);
        showToast('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.', 'warning');
        const unauthErr = new Error('UNAUTHORIZED');
        unauthErr.status = 401;
        throw unauthErr;
      }

      if (!res.ok) {
        const errorDetail = (data && data.error) || {};
        const err = new Error(errorDetail.message || `Lỗi HTTP ${res.status}`);
        err.status = res.status;
        err.code = errorDetail.code || 'API_ERROR';
        throw err;
      }

      return data;
    } catch (err) {
      if (err.message === 'Failed to fetch') {
        const netErr = new Error('Không thể kết nối đến máy chủ. Vui lòng kiểm tra lại mạng.');
        netErr.status = 503;
        netErr.code = 'NETWORK_ERROR';
        throw netErr;
      }
      throw err;
    }
  }

  // --- 6. XÁC THỰC VÀ GIAO DIỆN PHÂN QUYỀN ---

  function updateAuthUI() {
    if (STATE.token && STATE.user) {
      el.authSection.classList.add('hidden');
      el.dashboardSection.classList.remove('hidden');
      el.userProfile.classList.remove('hidden');

      el.userNameDisplay.textContent = STATE.user.username;
      el.userRoleBadge.textContent = STATE.user.role;
      el.userRoleBadge.className = `badge badge-${STATE.user.role.toLowerCase()}`;

      const isAdmin = STATE.user.role === 'ADMIN';
      document.querySelectorAll('.admin-only').forEach((elem) => {
        if (isAdmin) elem.classList.remove('hidden');
        else elem.classList.add('hidden');
      });
      document.querySelectorAll('.customer-only').forEach((elem) => {
        if (isAdmin) elem.classList.add('hidden');
        else elem.classList.remove('hidden');
      });

      // Mặc định chuyển sang tab phù hợp
      if (isAdmin && STATE.currentTab === 'transferTab') {
        switchDashboardTab('accountsTab');
      }

      loadAccounts();
    } else {
      el.authSection.classList.remove('hidden');
      el.dashboardSection.classList.add('hidden');
      el.userProfile.classList.add('hidden');
      STATE.accounts = [];
    }
  }

  function handleLoginSuccess(token, user) {
    STATE.token = token;
    STATE.user = user;
    sessionStorage.setItem('mb_token', token);
    sessionStorage.setItem('mb_user', JSON.stringify(user));
    showToast(`Đăng nhập thành công! Xin chào ${user.username}`, 'success');
    updateAuthUI();
  }

  function handleLogout(notify = true) {
    STATE.token = null;
    STATE.user = null;
    sessionStorage.removeItem('mb_token');
    sessionStorage.removeItem('mb_user');
    updateAuthUI();
    if (notify) showToast('Đã đăng xuất khỏi tài khoản', 'info');
  }

  function switchDashboardTab(targetTabId) {
    STATE.currentTab = targetTabId;

    el.navTabs.forEach((tab) => {
      if (tab.dataset.tab === targetTabId) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    el.tabPanes.forEach((pane) => {
      if (pane.id === targetTabId) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    if (targetTabId === 'historyTab') {
      loadHistory();
    }
  }

  // --- 7. QUẢN LÝ TÀI KHOẢN (RENDER AN TOÀN BẰNG TEXTCONTENT) ---

  async function loadAccounts() {
    try {
      el.refreshAccountsBtn.disabled = true;
      clearElement(el.accountsList);
      el.accountsList.appendChild(createEl('div', 'Đang tải danh sách tài khoản...', 'loading-placeholder'));

      const accounts = await api('/api/accounts');
      STATE.accounts = accounts || [];

      renderAccountsList(STATE.accounts);
      populateAccountDropdowns(STATE.accounts);
      updateSummaryMetrics(STATE.accounts);
    } catch (err) {
      if (err.message !== 'UNAUTHORIZED') {
        clearElement(el.accountsList);
        el.accountsList.appendChild(createEl('div', `Không thể tải tài khoản: ${getFriendlyMessage(err)}`, 'empty-message'));
        showToast(getFriendlyMessage(err), 'error');
      }
    } finally {
      el.refreshAccountsBtn.disabled = false;
    }
  }

  function updateSummaryMetrics(accounts) {
    const isAdmin = STATE.user && STATE.user.role === 'ADMIN';
    if (isAdmin) return;

    let total = 0;
    accounts.forEach((acc) => {
      total += Number(acc.balance || 0);
    });

    el.totalBalanceDisplay.textContent = formatCurrency(total);
    el.accountCountDisplay.textContent = `${accounts.length} / 3`;

    // BR-01: Tối đa 3 tài khoản đang hoạt động
    if (accounts.length >= 3) {
      el.openAccountBtn.disabled = true;
      el.openAccountBtn.title = 'Mỗi khách hàng chỉ được mở tối đa 3 tài khoản (BR-01)';
    } else {
      el.openAccountBtn.disabled = false;
      el.openAccountBtn.title = 'Mở tài khoản thanh toán mới';
    }
  }

  function renderAccountsList(accounts) {
    clearElement(el.accountsList);

    if (!accounts || accounts.length === 0) {
      const emptyDiv = createEl('div', null, 'empty-message');
      emptyDiv.style.gridColumn = '1 / -1';
      emptyDiv.style.textAlign = 'center';
      emptyDiv.appendChild(createEl('p', 'Chưa có tài khoản thanh toán nào'));
      if (STATE.user && STATE.user.role === 'CUSTOMER') {
        const btnBox = createEl('p', null, 'mt-3');
        const openBtn = createEl('button', 'Mở tài khoản ngay', 'btn btn-primary btn-sm');
        openBtn.onclick = () => el.openAccountBtn.click();
        btnBox.appendChild(openBtn);
        emptyDiv.appendChild(btnBox);
      }
      el.accountsList.appendChild(emptyDiv);
      return;
    }

    const isAdmin = STATE.user && STATE.user.role === 'ADMIN';

    accounts.forEach((acc) => {
      const statusClass = (acc.status || 'ACTIVE').toLowerCase();
      const card = createEl('div', null, `bank-card ${statusClass}`);

      // Header
      const header = createEl('div', null, 'bank-card-header');
      const typeSpan = createEl('span', `Thanh toán · ${acc.currency || 'VND'}`, 'bank-card-type');
      const chipSpan = createEl('span', '💳', 'bank-card-chip');
      header.appendChild(typeSpan);
      header.appendChild(chipSpan);
      card.appendChild(header);

      // Số tài khoản định dạng 4 số cách một lần (ví dụ: 1000 0000 0001)
      const formattedAccNum = String(acc.accountNumber).replace(/(\d{4})/g, '$1 ').trim();
      const numberDiv = createEl('div', formattedAccNum, 'bank-card-number');
      card.appendChild(numberDiv);

      // Footer
      const footer = createEl('div', null, 'bank-card-footer');

      const balanceBox = createEl('div', null, 'bank-card-balance-box');
      const balanceLabel = createEl('span', 'Số dư khả dụng', 'bank-card-balance-label');
      const balanceVal = createEl('span', formatCurrency(acc.balance), 'bank-card-balance');
      balanceBox.appendChild(balanceLabel);
      balanceBox.appendChild(balanceVal);
      footer.appendChild(balanceBox);

      const actionsBox = createEl('div', null, 'bank-card-actions');
      const badge = createEl('span', acc.status, `badge badge-${statusClass}`);
      actionsBox.appendChild(badge);

      // Dành cho ADMIN: nút đóng băng / mở băng nhanh trực tiếp
      if (isAdmin) {
        if (acc.status === 'ACTIVE') {
          const freezeBtn = createEl('button', '🔒 Đóng băng', 'btn btn-xs btn-outline');
          freezeBtn.title = 'Đóng băng tài khoản này (FROZEN)';
          freezeBtn.onclick = () => changeAccountStatusQuick(acc.accountNumber, 'FROZEN');
          actionsBox.appendChild(freezeBtn);
        } else if (acc.status === 'FROZEN') {
          const unfreezeBtn = createEl('button', '🔓 Mở băng', 'btn btn-xs btn-outline');
          unfreezeBtn.title = 'Mở băng tài khoản này (ACTIVE)';
          unfreezeBtn.onclick = () => changeAccountStatusQuick(acc.accountNumber, 'ACTIVE');
          actionsBox.appendChild(unfreezeBtn);
        }

        const editBtn = createEl('button', '⚙️', 'btn btn-xs btn-outline');
        editBtn.title = 'Tùy chọn trạng thái chi tiết';
        editBtn.onclick = () => openStatusModal(acc.accountNumber, acc.status);
        actionsBox.appendChild(editBtn);
      }

      footer.appendChild(actionsBox);
      card.appendChild(footer);
      el.accountsList.appendChild(card);
    });
  }

  function populateAccountDropdowns(accounts) {
    const activeAccounts = accounts.filter((a) => a.status === 'ACTIVE');

    // Nguồn chuyển khoản
    clearElement(el.transferFromAccount);
    el.transferFromAccount.appendChild(createEl('option', '-- Chọn tài khoản nguồn --', ''));
    activeAccounts.forEach((acc) => {
      const opt = createEl('option', `${acc.accountNumber} (${formatCurrency(acc.balance)})`);
      opt.value = acc.accountNumber;
      opt.dataset.balance = acc.balance;
      el.transferFromAccount.appendChild(opt);
    });

    // Nguồn rút tiền
    clearElement(el.withdrawFromAccount);
    el.withdrawFromAccount.appendChild(createEl('option', '-- Chọn tài khoản nguồn --', ''));
    activeAccounts.forEach((acc) => {
      const opt = createEl('option', `${acc.accountNumber} (${formatCurrency(acc.balance)})`);
      opt.value = acc.accountNumber;
      opt.dataset.balance = acc.balance;
      el.withdrawFromAccount.appendChild(opt);
    });

    // Lọc lịch sử
    clearElement(el.historyAccountSelect);
    el.historyAccountSelect.appendChild(createEl('option', '-- Tất cả tài khoản --', ''));
    accounts.forEach((acc) => {
      const opt = createEl('option', `${acc.accountNumber} (${acc.status})`);
      opt.value = acc.accountNumber;
      el.historyAccountSelect.appendChild(opt);
    });
  }

  // Mở tài khoản mới
  async function handleOpenAccount() {
    try {
      el.openAccountBtn.disabled = true;
      const res = await api('/api/accounts', { method: 'POST' });
      showToast(`Mở tài khoản thành công! Số tài khoản mới: ${res.accountNumber}`, 'success');
      await loadAccounts();
    } catch (err) {
      showToast(`Mở tài khoản thất bại: ${getFriendlyMessage(err)}`, 'error');
    } finally {
      el.openAccountBtn.disabled = false;
    }
  }

  // --- 8. XỬ LÝ GIAO DỊCH VỚI IDEMPOTENCY & AUTO-RETRY ---

  /**
   * Bộ thực thi giao dịch tài chính với Idempotency:
   * - Sinh key bằng crypto.randomUUID() khi người dùng gửi lần đầu.
   * - Khóa nút submit chống bấm đúp.
   * - Nhận 503 hoặc 409 REQUEST_IN_PROGRESS: tự gửi lại CÙNG key tối đa 3 lần, mỗi lần cách 2 giây.
   * - Chỉ sinh key mới khi thành công hoặc thất bại hẳn, hoặc người dùng sửa nội dung form.
   */
  async function executeTransactionWithRetry(formType, path, payload, submitBtn, defaultBtnText) {
    if (STATE.idempotency[formType].isSubmitting) return;

    // Nếu chưa có key (hoặc người dùng vừa sửa form), sinh key mới
    if (!STATE.idempotency[formType].key) {
      STATE.idempotency[formType].key = generateUUID();
    }
    const currentKey = STATE.idempotency[formType].key;

    STATE.idempotency[formType].isSubmitting = true;
    submitBtn.disabled = true;

    const MAX_RETRIES = 3;
    let attempt = 0;
    let lastError = null;

    try {
      while (attempt <= MAX_RETRIES) {
        if (attempt === 0) {
          submitBtn.textContent = 'Đang xử lý giao dịch...';
        } else {
          submitBtn.textContent = `Đang thử lại (${attempt}/${MAX_RETRIES})...`;
        }

        try {
          const res = await api(path, {
            method: 'POST',
            headers: {
              'Idempotency-Key': currentKey,
            },
            body: payload,
          });

          // Thành công -> xóa key để lần giao dịch sau sinh key mới
          STATE.idempotency[formType].key = null;
          return res;
        } catch (err) {
          lastError = err;
          const isRetryable =
            err.status === 503 || (err.status === 409 && err.code === 'REQUEST_IN_PROGRESS');

          if (isRetryable && attempt < MAX_RETRIES) {
            attempt++;
            showToast(`Yêu cầu đang xử lý, tự động gửi lại sau 2 giây (lần ${attempt}/${MAX_RETRIES})...`, 'info', 2500);
            await new Promise((resolve) => setTimeout(resolve, 2000));
            // Tiếp tục vòng lặp với CÙNG key
            continue;
          }

          // Lỗi nghiệp vụ khác (400, 403, 422...) hoặc đã hết số lần thử lại
          // -> Coi như thất bại hẳn, xóa key để lần gửi sau sinh key mới
          STATE.idempotency[formType].key = null;
          throw lastError;
        }
      }
    } finally {
      STATE.idempotency[formType].isSubmitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = defaultBtnText;
    }
  }

  // Chuyển khoản
  async function handleTransferSubmit(e) {
    e.preventDefault();
    const fromAccount = el.transferFromAccount.value;
    const toAccount = el.transferToAccount.value.trim();
    const amountVal = el.transferAmount.value.trim();
    const amount = Number(amountVal);
    const description = el.transferDescription.value.trim();

    if (!fromAccount || !toAccount || !amountVal) {
      showToast('Vui lòng điền đầy đủ các thông tin bắt buộc', 'warning');
      return;
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      showToast('Số tiền chuyển phải là số nguyên dương hợp lệ', 'warning');
      return;
    }

    if (fromAccount === toAccount) {
      showToast('Không thể chuyển tiền cho chính tài khoản nguồn (BR-07)', 'warning');
      return;
    }

    try {
      const res = await executeTransactionWithRetry(
        'transfer',
        '/api/transactions/transfer',
        {
          fromAccount,
          toAccount,
          amount,
          description: description || undefined,
        },
        el.transferSubmitBtn,
        'Xác nhận chuyển tiền'
      );

      showReceiptModal({
        title: 'Chuyển tiền thành công',
        type: 'TRANSFER',
        status: res.status,
        amount: res.amount,
        fromAccount: res.fromAccount,
        toAccount: res.toAccount,
        id: res.id,
        createdAt: res.createdAt,
        description: res.description,
      });

      el.transferForm.reset();
      el.transferSourceBalanceHint.textContent = '';
      await loadAccounts();
    } catch (err) {
      const friendlyMsg = getFriendlyMessage(err);
      showToast(`Chuyển tiền thất bại: ${friendlyMsg}`, 'error', 6000);
      showReceiptModal({
        title: 'Chuyển tiền thất bại',
        type: 'TRANSFER',
        status: 'FAILED',
        failureCode: err.code,
        failureMessage: friendlyMsg,
        amount,
        fromAccount,
        toAccount,
        description,
      });
    }
  }

  // Rút tiền
  async function handleWithdrawSubmit(e) {
    e.preventDefault();
    const fromAccount = el.withdrawFromAccount.value;
    const amountVal = el.withdrawAmount.value.trim();
    const amount = Number(amountVal);
    const description = el.withdrawDescription.value.trim();

    if (!fromAccount || !amountVal) {
      showToast('Vui lòng điền đầy đủ thông tin bắt buộc', 'warning');
      return;
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      showToast('Số tiền rút phải là số nguyên dương hợp lệ', 'warning');
      return;
    }

    try {
      const res = await executeTransactionWithRetry(
        'withdraw',
        '/api/transactions/withdraw',
        {
          fromAccount,
          amount,
          description: description || undefined,
        },
        el.withdrawSubmitBtn,
        'Xác nhận rút tiền'
      );

      showReceiptModal({
        title: 'Rút tiền thành công',
        type: 'WITHDRAW',
        status: res.status,
        amount: res.amount,
        fromAccount: res.fromAccount,
        id: res.id,
        createdAt: res.createdAt,
        description: res.description,
      });

      el.withdrawForm.reset();
      el.withdrawSourceBalanceHint.textContent = '';
      await loadAccounts();
    } catch (err) {
      const friendlyMsg = getFriendlyMessage(err);
      showToast(`Rút tiền không thành công: ${friendlyMsg}`, 'error', 6000);
      showReceiptModal({
        title: 'Rút tiền thất bại',
        type: 'WITHDRAW',
        status: 'FAILED',
        failureCode: err.code,
        failureMessage: friendlyMsg,
        amount,
        fromAccount,
        description,
      });
    }
  }

  // Nạp tiền (ADMIN)
  async function handleDepositSubmit(e) {
    e.preventDefault();
    const toAccount = el.depositToAccount.value.trim();
    const amountVal = el.depositAmount.value.trim();
    const amount = Number(amountVal);
    const description = el.depositDescription.value.trim();

    if (!toAccount || !amountVal) {
      showToast('Vui lòng điền đầy đủ thông tin bắt buộc', 'warning');
      return;
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      showToast('Số tiền nạp phải là số nguyên dương hợp lệ', 'warning');
      return;
    }

    try {
      const res = await executeTransactionWithRetry(
        'deposit',
        '/api/transactions/deposit',
        {
          toAccount,
          amount,
          description: description || undefined,
        },
        el.depositSubmitBtn,
        'Xác nhận nạp tiền'
      );

      showReceiptModal({
        title: 'Nạp tiền thành công',
        type: 'DEPOSIT',
        status: res.status,
        amount: res.amount,
        toAccount: res.toAccount,
        id: res.id,
        createdAt: res.createdAt,
        description: res.description,
      });

      el.depositForm.reset();
      await loadAccounts();
    } catch (err) {
      const friendlyMsg = getFriendlyMessage(err);
      showToast(`Nạp tiền thất bại: ${friendlyMsg}`, 'error', 6000);
      showReceiptModal({
        title: 'Nạp tiền thất bại',
        type: 'DEPOSIT',
        status: 'FAILED',
        failureCode: err.code,
        failureMessage: friendlyMsg,
        amount,
        toAccount,
        description,
      });
    }
  }

  // --- 9. LỊCH SỬ GIAO DỊCH & SAO KÊ SỔ CÁI (RENDER AN TOÀN BẰNG TEXTCONTENT) ---

  async function loadHistory() {
    const mode = STATE.history.mode;
    const account = el.historyAccountSelect.value || '';
    const page = STATE.history.page;
    const size = STATE.history.size;

    if (mode === 'postings' && !account) {
      clearElement(el.historyTableHead);
      clearElement(el.historyTableBody);
      const row = createEl('tr');
      const td = createEl('td', 'Vui lòng chọn một số tài khoản cụ thể để xem sao kê sổ cái (Postings)', 'text-center empty-message');
      td.colSpan = 6;
      row.appendChild(td);
      el.historyTableBody.appendChild(row);
      el.paginationBar.classList.add('hidden');
      return;
    }

    try {
      clearElement(el.historyTableBody);
      const loadingRow = createEl('tr');
      const loadingTd = createEl('td', 'Đang tải dữ liệu...', 'text-center empty-message');
      loadingTd.colSpan = 7;
      loadingRow.appendChild(loadingTd);
      el.historyTableBody.appendChild(loadingRow);

      if (mode === 'transactions') {
        const query = new URLSearchParams({ page, size });
        if (account) query.append('account', account);
        const data = await api(`/api/transactions?${query.toString()}`);
        renderTransactionsTable(data || [], account);
      } else {
        const query = new URLSearchParams({ page, size });
        const data = await api(`/api/accounts/${account}/postings?${query.toString()}`);
        renderPostingsTable(data || []);
      }
    } catch (err) {
      if (err.message !== 'UNAUTHORIZED') {
        clearElement(el.historyTableBody);
        const errRow = createEl('tr');
        const errTd = createEl('td', `Lỗi tải dữ liệu: ${getFriendlyMessage(err)}`, 'text-center empty-message');
        errTd.colSpan = 7;
        errRow.appendChild(errTd);
        el.historyTableBody.appendChild(errRow);
      }
    }
  }

  /**
   * Render bảng giao dịch:
   * - Tiền vào hiện màu xanh dấu +
   * - Tiền ra hiện màu đỏ dấu −
   * - Mọi trường dữ liệu render bằng textContent (chống XSS)
   */
  function renderTransactionsTable(transactions, selectedAccount) {
    clearElement(el.historyTableHead);
    clearElement(el.historyTableBody);

    const headRow = createEl('tr');
    ['Thời gian', 'Loại giao dịch', 'Tài khoản nguồn', 'Tài khoản đích', 'Số tiền', 'Trạng thái', 'Nội dung'].forEach((col) => {
      headRow.appendChild(createEl('th', col));
    });
    el.historyTableHead.appendChild(headRow);

    if (transactions.length === 0) {
      const emptyRow = createEl('tr');
      const emptyTd = createEl('td', 'Chưa có giao dịch nào được ghi nhận', 'text-center empty-message');
      emptyTd.colSpan = 7;
      emptyRow.appendChild(emptyTd);
      el.historyTableBody.appendChild(emptyRow);
      el.paginationBar.classList.add('hidden');
      return;
    }

    transactions.forEach((t) => {
      const row = createEl('tr');

      // Thời gian
      row.appendChild(createEl('td', formatDateTime(t.createdAt)));

      // Loại giao dịch badge
      const tdType = createEl('td');
      let typeLabel = t.type;
      let badgeStyle = 'badge-customer';
      if (t.type === 'DEPOSIT') {
        typeLabel = 'Nạp tiền';
        badgeStyle = 'badge-completed';
      } else if (t.type === 'WITHDRAW') {
        typeLabel = 'Rút tiền';
        badgeStyle = 'badge-frozen';
      } else if (t.type === 'TRANSFER') {
        typeLabel = 'Chuyển khoản';
        badgeStyle = 'badge-customer';
      }
      tdType.appendChild(createEl('span', typeLabel, `badge ${badgeStyle}`));
      row.appendChild(tdType);

      // Tài khoản nguồn
      const tdFrom = createEl('td');
      tdFrom.appendChild(createEl('code', t.fromAccount || '—'));
      row.appendChild(tdFrom);

      // Tài khoản đích
      const tdTo = createEl('td');
      tdTo.appendChild(createEl('code', t.toAccount || '—'));
      row.appendChild(tdTo);

      // Xác định tiền vào (+) hay tiền ra (-)
      let isIncome = false;
      let isExpense = false;

      if (t.type === 'DEPOSIT') {
        isIncome = true;
      } else if (t.type === 'WITHDRAW') {
        isExpense = true;
      } else if (t.type === 'TRANSFER') {
        if (selectedAccount) {
          if (t.toAccount === selectedAccount) isIncome = true;
          else if (t.fromAccount === selectedAccount) isExpense = true;
        } else {
          // Khi không lọc tài khoản cụ thể, đối chiếu với danh sách tài khoản của user
          const myAccounts = new Set(STATE.accounts.map((a) => a.accountNumber));
          if (myAccounts.has(t.toAccount) && !myAccounts.has(t.fromAccount)) isIncome = true;
          else if (myAccounts.has(t.fromAccount) && !myAccounts.has(t.toAccount)) isExpense = true;
        }
      }

      let amountText = formatCurrency(t.amount);
      let amountClass = '';
      if (isIncome) {
        amountText = `+${amountText}`;
        amountClass = 'amount-plus';
      } else if (isExpense) {
        amountText = `−${amountText}`;
        amountClass = 'amount-minus';
      }

      const tdAmount = createEl('td');
      tdAmount.appendChild(createEl('strong', amountText, amountClass));
      row.appendChild(tdAmount);

      // Trạng thái badge
      const tdStatus = createEl('td');
      const statusLower = (t.status || '').toLowerCase();
      tdStatus.appendChild(createEl('span', t.status, `badge badge-${statusLower}`));
      row.appendChild(tdStatus);

      // Nội dung mô tả (an toàn bằng textContent)
      row.appendChild(createEl('td', t.description || '—'));

      el.historyTableBody.appendChild(row);
    });

    updatePaginationBar(transactions.length);
  }

  /**
   * Render bảng sao kê sổ cái (Postings)
   */
  function renderPostingsTable(postings) {
    clearElement(el.historyTableHead);
    clearElement(el.historyTableBody);

    const headRow = createEl('tr');
    ['Thời gian', 'Số tiền phát sinh', 'Số dư sau giao dịch', 'Nội dung', 'Mã giao dịch (Txn ID)'].forEach((col) => {
      headRow.appendChild(createEl('th', col));
    });
    el.historyTableHead.appendChild(headRow);

    if (postings.length === 0) {
      const emptyRow = createEl('tr');
      const emptyTd = createEl('td', 'Chưa có bút toán sổ cái nào cho tài khoản này', 'text-center empty-message');
      emptyTd.colSpan = 5;
      emptyRow.appendChild(emptyTd);
      el.historyTableBody.appendChild(emptyRow);
      el.paginationBar.classList.add('hidden');
      return;
    }

    postings.forEach((p) => {
      const row = createEl('tr');

      // Thời gian
      row.appendChild(createEl('td', formatDateTime(p.createdAt)));

      // Số tiền (+ / -)
      const amt = Number(p.amount);
      const isPositive = amt > 0;
      const amtStr = isPositive ? `+${formatCurrency(amt)}` : `−${formatCurrency(Math.abs(amt))}`;
      const amtClass = isPositive ? 'amount-plus' : 'amount-minus';

      const tdAmt = createEl('td');
      tdAmt.appendChild(createEl('strong', amtStr, amtClass));
      row.appendChild(tdAmt);

      // Số dư sau giao dịch
      const tdBalAfter = createEl('td');
      tdBalAfter.appendChild(createEl('strong', formatCurrency(p.balanceAfter)));
      row.appendChild(tdBalAfter);

      // Nội dung
      row.appendChild(createEl('td', p.description || '—'));

      // Txn ID
      const tdTxn = createEl('td');
      const shortId = p.transactionId ? `${p.transactionId.substring(0, 8)}...` : '—';
      const codeNode = createEl('code', shortId);
      codeNode.title = p.transactionId;
      tdTxn.appendChild(codeNode);
      row.appendChild(tdTxn);

      el.historyTableBody.appendChild(row);
    });

    updatePaginationBar(postings.length);
  }

  function updatePaginationBar(itemCount) {
    el.paginationBar.classList.remove('hidden');
    el.pageIndicator.textContent = `Trang ${STATE.history.page}`;
    el.prevPageBtn.disabled = STATE.history.page <= 1;
    el.nextPageBtn.disabled = itemCount < STATE.history.size;
  }

  // --- 10. MODAL VÀ THAO TÁC ADMIN (RENDER AN TOÀN BẰNG TEXTCONTENT) ---

  function showReceiptModal(data) {
    const isSuccess = data.status === 'COMPLETED' || data.status === 'PENDING';
    el.receiptModalTitle.textContent = data.title || 'Biên lai giao dịch';

    clearElement(el.receiptModalBody);
    const box = createEl('div', null, 'receipt-box');

    // Banner trạng thái
    const bannerClass = isSuccess ? 'receipt-status-banner success' : 'receipt-status-banner failed';
    const banner = createEl('div', null, bannerClass);
    const headerTitle = isSuccess
      ? `✅ Giao dịch ${data.status === 'COMPLETED' ? 'Thành công' : 'Đang xử lý'}`
      : '❌ Giao dịch Thất bại';
    banner.appendChild(createEl('h3', headerTitle));

    if (data.amount) {
      const amtP = createEl('p', formatCurrency(data.amount));
      amtP.style.fontSize = '1.5rem';
      amtP.style.fontWeight = '700';
      amtP.style.marginTop = '0.25rem';
      banner.appendChild(amtP);
    }

    if (!isSuccess && data.failureMessage) {
      const failP = createEl('p', data.failureMessage);
      failP.style.fontWeight = '600';
      failP.style.marginTop = '0.25rem';
      banner.appendChild(failP);
    }
    box.appendChild(banner);

    // Bảng chi tiết biên lai
    function addReceiptRow(label, value, isCode = false) {
      if (value === undefined || value === null || value === '') return;
      const row = createEl('div', null, 'receipt-row');
      row.appendChild(createEl('span', label, 'receipt-row-label'));
      const valSpan = createEl('span', null, 'receipt-row-value');
      if (isCode) valSpan.appendChild(createEl('code', value));
      else valSpan.textContent = String(value);
      row.appendChild(valSpan);
      box.appendChild(row);
    }

    addReceiptRow('Mã giao dịch:', data.id, true);
    addReceiptRow('Tài khoản trích tiền:', data.fromAccount, true);
    addReceiptRow('Tài khoản thụ hưởng:', data.toAccount, true);
    addReceiptRow('Nội dung:', data.description);
    if (data.createdAt) {
      addReceiptRow('Thời gian:', formatDateTime(data.createdAt));
    }

    el.receiptModalBody.appendChild(box);
    el.receiptModal.classList.remove('hidden');
  }

  function openStatusModal(accountNumber, currentStatus) {
    STATE.targetStatusAccount = accountNumber;
    el.statusTargetAccountDisplay.textContent = accountNumber;
    el.newStatusSelect.value = currentStatus || 'ACTIVE';
    el.statusModal.classList.remove('hidden');
  }

  async function changeAccountStatusQuick(accountNumber, newStatus) {
    const confirmMsg = newStatus === 'FROZEN'
      ? `Bạn có chắc chắn muốn ĐÓNG BĂNG tài khoản ${accountNumber}? Tài khoản này sẽ không thể rút/chuyển tiền.`
      : `Bạn có chắc chắn muốn MỞ BĂNG cho tài khoản ${accountNumber}?`;

    if (!confirm(confirmMsg)) return;

    try {
      await api(`/api/accounts/${accountNumber}/status`, {
        method: 'PATCH',
        body: { status: newStatus },
      });
      showToast(`Đã đổi trạng thái tài khoản ${accountNumber} thành ${newStatus}`, 'success');
      await loadAccounts();
    } catch (err) {
      showToast(`Lỗi đổi trạng thái: ${getFriendlyMessage(err)}`, 'error');
    }
  }

  async function handleStatusSubmit() {
    if (!STATE.targetStatusAccount) return;
    const newStatus = el.newStatusSelect.value;

    try {
      el.submitStatusBtn.disabled = true;
      await api(`/api/accounts/${STATE.targetStatusAccount}/status`, {
        method: 'PATCH',
        body: { status: newStatus },
      });

      showToast(`Đã cập nhật trạng thái tài khoản ${STATE.targetStatusAccount} sang ${newStatus}`, 'success');
      el.statusModal.classList.add('hidden');
      await loadAccounts();
    } catch (err) {
      showToast(`Lỗi đổi trạng thái: ${getFriendlyMessage(err)}`, 'error');
    } finally {
      el.submitStatusBtn.disabled = false;
    }
  }

  // --- 11. KHỞI TẠO VÀ SỰ KIỆN ---

  function enforceIntegerInput(inputElement) {
    if (!inputElement) return;
    inputElement.addEventListener('input', (e) => {
      // Chỉ nhận ký tự số nguyên
      e.target.value = e.target.value.replace(/[^0-9]/g, '');
    });
  }

  function setupEventListeners() {
    // Chặn nhập ký tự không phải số nguyên cho các ô số tiền
    enforceIntegerInput(el.transferAmount);
    enforceIntegerInput(el.withdrawAmount);
    enforceIntegerInput(el.depositAmount);

    // Chặn nhập CCCD và số tài khoản chỉ nhận số
    enforceIntegerInput(document.getElementById('regIdNumber'));
    enforceIntegerInput(el.transferToAccount);
    enforceIntegerInput(el.depositToAccount);

    // Reset Idempotency-Key khi người dùng sửa nội dung form
    el.transferForm.addEventListener('input', () => {
      STATE.idempotency.transfer.key = null;
    });
    el.withdrawForm.addEventListener('input', () => {
      STATE.idempotency.withdraw.key = null;
    });
    el.depositForm.addEventListener('input', () => {
      STATE.idempotency.deposit.key = null;
    });

    // Chuyển tab Auth
    el.tabLoginBtn.addEventListener('click', () => {
      el.tabLoginBtn.classList.add('active');
      el.tabRegisterBtn.classList.remove('active');
      el.loginFormContainer.classList.remove('hidden');
      el.registerFormContainer.classList.add('hidden');
    });

    el.tabRegisterBtn.addEventListener('click', () => {
      el.tabRegisterBtn.classList.add('active');
      el.tabLoginBtn.classList.remove('active');
      el.registerFormContainer.classList.remove('hidden');
      el.loginFormContainer.classList.add('hidden');
    });

    // Tài khoản mẫu
    document.querySelectorAll('.demo-fill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.loginUsername.value = btn.dataset.user;
        el.loginPassword.value = btn.dataset.pass;
      });
    });

    // Submit Đăng nhập
    el.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = el.loginUsername.value.trim();
      const password = el.loginPassword.value;

      if (!username || !password) return;

      try {
        el.loginSubmitBtn.disabled = true;
        el.loginSubmitBtn.textContent = 'Đang xác thực...';

        const res = await api('/api/auth/login', {
          method: 'POST',
          body: { username, password },
        });

        handleLoginSuccess(res.token, res.user);
      } catch (err) {
        showToast(getFriendlyMessage(err), 'error');
      } finally {
        el.loginSubmitBtn.disabled = false;
        el.loginSubmitBtn.textContent = 'Đăng nhập';
      }
    });

    // Submit Đăng ký
    el.registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('regUsername').value.trim();
      const password = document.getElementById('regPassword').value;
      const fullName = document.getElementById('regFullName').value.trim();
      const idNumber = document.getElementById('regIdNumber').value.trim();
      const phone = document.getElementById('regPhone').value.trim() || undefined;
      const email = document.getElementById('regEmail').value.trim() || undefined;

      try {
        el.registerSubmitBtn.disabled = true;
        el.registerSubmitBtn.textContent = 'Đang đăng ký...';

        const res = await api('/api/auth/register', {
          method: 'POST',
          body: { username, password, fullName, idNumber, phone, email },
        });

        showToast('Đăng ký tài khoản thành công! Tự động đăng nhập...', 'success');
        handleLoginSuccess(res.token, res.user);
      } catch (err) {
        showToast(`Đăng ký thất bại: ${getFriendlyMessage(err)}`, 'error');
      } finally {
        el.registerSubmitBtn.disabled = false;
        el.registerSubmitBtn.textContent = 'Đăng ký tài khoản';
      }
    });

    // Đăng xuất
    el.logoutBtn.addEventListener('click', () => handleLogout(true));

    // Chuyển tab Dashboard
    el.navTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        switchDashboardTab(tab.dataset.tab);
      });
    });

    // Mở tài khoản & Làm mới
    el.openAccountBtn.addEventListener('click', handleOpenAccount);
    el.refreshAccountsBtn.addEventListener('click', loadAccounts);

    // Gợi ý số dư khả dụng khi chọn tài khoản nguồn
    el.transferFromAccount.addEventListener('change', () => {
      const selected = el.transferFromAccount.options[el.transferFromAccount.selectedIndex];
      if (selected && selected.dataset.balance !== undefined) {
        el.transferSourceBalanceHint.textContent = `Số dư khả dụng: ${formatCurrency(selected.dataset.balance)}`;
      } else {
        el.transferSourceBalanceHint.textContent = '';
      }
    });

    el.withdrawFromAccount.addEventListener('change', () => {
      const selected = el.withdrawFromAccount.options[el.withdrawFromAccount.selectedIndex];
      if (selected && selected.dataset.balance !== undefined) {
        el.withdrawSourceBalanceHint.textContent = `Số dư khả dụng: ${formatCurrency(selected.dataset.balance)}`;
      } else {
        el.withdrawSourceBalanceHint.textContent = '';
      }
    });

    // Phím chọn nhanh số tiền
    document.querySelectorAll('.quick-amount-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetInput = document.getElementById(btn.dataset.target);
        if (targetInput) {
          targetInput.value = btn.dataset.val;
          // Phát event input để reset Idempotency key
          targetInput.dispatchEvent(new Event('input'));
        }
      });
    });

    // Form giao dịch
    el.transferForm.addEventListener('submit', handleTransferSubmit);
    el.withdrawForm.addEventListener('submit', handleWithdrawSubmit);
    el.depositForm.addEventListener('submit', handleDepositSubmit);

    // Điều khiển tab Lịch sử
    el.viewTransactionsBtn.addEventListener('click', () => {
      STATE.history.mode = 'transactions';
      STATE.history.page = 1;
      el.viewTransactionsBtn.classList.add('btn-primary', 'active');
      el.viewTransactionsBtn.classList.remove('btn-outline');
      el.viewPostingsBtn.classList.add('btn-outline');
      el.viewPostingsBtn.classList.remove('btn-primary', 'active');
      loadHistory();
    });

    el.viewPostingsBtn.addEventListener('click', () => {
      STATE.history.mode = 'postings';
      STATE.history.page = 1;
      el.viewPostingsBtn.classList.add('btn-primary', 'active');
      el.viewPostingsBtn.classList.remove('btn-outline');
      el.viewTransactionsBtn.classList.add('btn-outline');
      el.viewTransactionsBtn.classList.remove('btn-primary', 'active');
      loadHistory();
    });

    el.historyAccountSelect.addEventListener('change', () => {
      STATE.history.page = 1;
      loadHistory();
    });

    el.prevPageBtn.addEventListener('click', () => {
      if (STATE.history.page > 1) {
        STATE.history.page--;
        loadHistory();
      }
    });

    el.nextPageBtn.addEventListener('click', () => {
      STATE.history.page++;
      loadHistory();
    });

    // Modals
    el.closeReceiptModalBtn.addEventListener('click', () => el.receiptModal.classList.add('hidden'));
    el.receiptDoneBtn.addEventListener('click', () => el.receiptModal.classList.add('hidden'));

    el.closeStatusModalBtn.addEventListener('click', () => el.statusModal.classList.add('hidden'));
    el.cancelStatusBtn.addEventListener('click', () => el.statusModal.classList.add('hidden'));
    el.submitStatusBtn.addEventListener('click', handleStatusSubmit);
  }

  // Khởi chạy ứng dụng
  setupEventListeners();
  updateAuthUI();

})();
