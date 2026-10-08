/**
 * Mini Bank - Frontend Logic
 * Vanilla JavaScript (Không framework, không build step)
 * Lưu JWT trong sessionStorage, gọi API qua cùng tên miền (/api/...)
 */

(function () {
  'use strict';

  // --- 1. STATE & CONSTANTS ---
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
    targetStatusAccount: null,
  };

  // --- 2. DOM ELEMENTS ---
  const el = {
    // Header
    userProfile: document.getElementById('userProfile'),
    userNameDisplay: document.getElementById('userNameDisplay'),
    userRoleBadge: document.getElementById('userRoleBadge'),
    logoutBtn: document.getElementById('logoutBtn'),

    // Toast
    toastContainer: document.getElementById('toastContainer'),

    // Auth
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

    // Dashboard Navigation
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

  // --- 3. HELPER FUNCTIONS ---

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
      return isoString;
    }
  }

  function showToast(message, type = 'info', duration = 4000) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.className = 'toast-msg';
    msgSpan.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => toast.remove();

    toast.appendChild(msgSpan);
    toast.appendChild(closeBtn);
    el.toastContainer.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) toast.remove();
    }, duration);
  }

  // API Client Wrapper
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

      if (res.status === 401) {
        // Hết phiên đăng nhập
        handleLogout(false);
        showToast('Phiên làm việc đã hết hạn. Vui lòng đăng nhập lại.', 'warning');
        throw new Error('UNAUTHORIZED');
      }

      if (!res.ok) {
        const errorDetail = (data && data.error) || {};
        const err = new Error(errorDetail.message || `Lỗi yêu cầu (HTTP ${res.status})`);
        err.status = res.status;
        err.code = errorDetail.code || 'API_ERROR';
        throw err;
      }

      return data;
    } catch (err) {
      if (err.message === 'Failed to fetch') {
        const networkErr = new Error('Không thể kết nối tới máy chủ. Vui lòng thử lại sau.');
        networkErr.status = 503;
        networkErr.code = 'NETWORK_ERROR';
        throw networkErr;
      }
      throw err;
    }
  }

  // --- 4. AUTH & SESSION LOGIC ---

  function updateAuthUI() {
    if (STATE.token && STATE.user) {
      el.authSection.classList.add('hidden');
      el.dashboardSection.classList.remove('hidden');
      el.userProfile.classList.remove('hidden');

      el.userNameDisplay.textContent = STATE.user.username;
      el.userRoleBadge.textContent = STATE.user.role;
      el.userRoleBadge.className = `badge badge-${STATE.user.role.toLowerCase()}`;

      // Ẩn/hiện tính năng theo vai trò
      const isAdmin = STATE.user.role === 'ADMIN';
      document.querySelectorAll('.admin-only').forEach((elem) => {
        if (isAdmin) elem.classList.remove('hidden');
        else elem.classList.add('hidden');
      });
      document.querySelectorAll('.customer-only').forEach((elem) => {
        if (isAdmin) elem.classList.add('hidden');
        else elem.classList.remove('hidden');
      });

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
    showToast(`Chào mừng ${user.username} đã đăng nhập thành công!`, 'success');
    updateAuthUI();
  }

  function handleLogout(notify = true) {
    STATE.token = null;
    STATE.user = null;
    sessionStorage.removeItem('mb_token');
    sessionStorage.removeItem('mb_user');
    updateAuthUI();
    if (notify) showToast('Đã đăng xuất khỏi hệ thống.', 'info');
  }

  // --- 5. TABS & NAVIGATION ---

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

  // --- 6. ACCOUNTS MANAGEMENT ---

  async function loadAccounts() {
    try {
      el.refreshAccountsBtn.disabled = true;
      el.accountsList.innerHTML = '<div class="loading-placeholder">Đang tải danh sách tài khoản...</div>';

      const accounts = await api('/api/accounts');
      STATE.accounts = accounts || [];

      renderAccountsList(STATE.accounts);
      populateAccountDropdowns(STATE.accounts);
      updateSummaryMetrics(STATE.accounts);
    } catch (err) {
      if (err.message !== 'UNAUTHORIZED') {
        el.accountsList.innerHTML = `<div class="empty-message">Không thể tải tài khoản: ${err.message}</div>`;
        showToast(`Lỗi tải tài khoản: ${err.message}`, 'error');
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

    // Nếu đã đủ 3 tài khoản thì vô hiệu hóa nút mở tài khoản mới (BR-01)
    if (accounts.length >= 3) {
      el.openAccountBtn.disabled = true;
      el.openAccountBtn.title = 'Mỗi khách hàng chỉ được mở tối đa 3 tài khoản đang hoạt động (BR-01)';
    } else {
      el.openAccountBtn.disabled = false;
      el.openAccountBtn.title = 'Mở tài khoản thanh toán mới';
    }
  }

  function renderAccountsList(accounts) {
    if (!accounts || accounts.length === 0) {
      el.accountsList.innerHTML = `
        <div class="empty-message" style="grid-column: 1 / -1; text-align: center;">
          <p>Chưa có tài khoản thanh toán nào.</p>
          ${
            STATE.user && STATE.user.role === 'CUSTOMER'
              ? '<p class="mt-3"><button class="btn btn-primary btn-sm" onclick="document.getElementById(\'openAccountBtn\').click()">Mở tài khoản ngay</button></p>'
              : ''
          }
        </div>`;
      return;
    }

    const isAdmin = STATE.user && STATE.user.role === 'ADMIN';

    el.accountsList.innerHTML = accounts
      .map((acc) => {
        const statusClass = acc.status ? acc.status.toLowerCase() : 'active';
        return `
          <div class="bank-card ${statusClass}">
            <div class="bank-card-header">
              <span class="bank-card-type">Thanh toán · ${acc.currency || 'VND'}</span>
              <span class="bank-card-chip">💳</span>
            </div>

            <div class="bank-card-number">
              ${acc.accountNumber.replace(/(\d{4})/g, '$1 ').trim()}
            </div>

            <div class="bank-card-footer">
              <div class="bank-card-balance-box">
                <span class="bank-card-balance-label">Số dư khả dụng</span>
                <span class="bank-card-balance">${formatCurrency(acc.balance)}</span>
              </div>

              <div class="bank-card-actions">
                <span class="badge badge-${statusClass}">${acc.status}</span>
                ${
                  isAdmin
                    ? `<button class="btn btn-xs btn-outline edit-status-btn" data-acc="${acc.accountNumber}" data-status="${acc.status}" title="Đổi trạng thái tài khoản">⚙️</button>`
                    : ''
                }
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    // Bắt sự kiện đổi trạng thái cho Admin
    if (isAdmin) {
      document.querySelectorAll('.edit-status-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          openStatusModal(btn.dataset.acc, btn.dataset.status);
        });
      });
    }
  }

  function populateAccountDropdowns(accounts) {
    const activeAccounts = accounts.filter((a) => a.status === 'ACTIVE');

    // Dropdown chuyển khoản nguồn
    el.transferFromAccount.innerHTML = '<option value="">-- Chọn tài khoản nguồn --</option>';
    activeAccounts.forEach((acc) => {
      const opt = document.createElement('option');
      opt.value = acc.accountNumber;
      opt.textContent = `${acc.accountNumber} (${formatCurrency(acc.balance)})`;
      opt.dataset.balance = acc.balance;
      el.transferFromAccount.appendChild(opt);
    });

    // Dropdown rút tiền nguồn
    el.withdrawFromAccount.innerHTML = '<option value="">-- Chọn tài khoản nguồn --</option>';
    activeAccounts.forEach((acc) => {
      const opt = document.createElement('option');
      opt.value = acc.accountNumber;
      opt.textContent = `${acc.accountNumber} (${formatCurrency(acc.balance)})`;
      opt.dataset.balance = acc.balance;
      el.withdrawFromAccount.appendChild(opt);
    });

    // Dropdown lọc lịch sử
    el.historyAccountSelect.innerHTML = '<option value="">-- Tất cả tài khoản --</option>';
    accounts.forEach((acc) => {
      const opt = document.createElement('option');
      opt.value = acc.accountNumber;
      opt.textContent = `${acc.accountNumber} (${acc.status})`;
      el.historyAccountSelect.appendChild(opt);
    });
  }

  // Mở tài khoản mới (CUSTOMER)
  async function handleOpenAccount() {
    try {
      el.openAccountBtn.disabled = true;
      const res = await api('/api/accounts', { method: 'POST' });
      showToast(`Mở tài khoản thành công! Số tài khoản: ${res.accountNumber}`, 'success');
      await loadAccounts();
    } catch (err) {
      showToast(`Không thể mở tài khoản: [${err.code || 'ERROR'}] ${err.message}`, 'error');
    } finally {
      el.openAccountBtn.disabled = false;
    }
  }

  // --- 7. TRANSACTIONS LOGIC (TRANSFER, WITHDRAW, DEPOSIT) ---

  // Chuyển khoản
  async function handleTransferSubmit(e) {
    e.preventDefault();
    const fromAccount = el.transferFromAccount.value;
    const toAccount = el.transferToAccount.value.trim();
    const amount = parseInt(el.transferAmount.value, 10);
    const description = el.transferDescription.value.trim();

    if (!fromAccount || !toAccount || !amount) {
      showToast('Vui lòng điền đầy đủ thông tin bắt buộc', 'warning');
      return;
    }

    if (fromAccount === toAccount) {
      showToast('Tài khoản nguồn và đích không được trùng nhau (BR-07)', 'warning');
      return;
    }

    const idempotencyKey = generateUUID();

    try {
      el.transferSubmitBtn.disabled = true;
      el.transferSubmitBtn.innerHTML = '<span>Đang xử lý chuyển tiền...</span> ⏳';

      const res = await api('/api/transactions/transfer', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: {
          fromAccount,
          toAccount,
          amount,
          description: description || undefined,
        },
      });

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
      showToast(`Chuyển tiền thất bại: [${err.code || 'ERROR'}] ${err.message}`, 'error', 6000);
      showReceiptModal({
        title: 'Chuyển tiền thất bại',
        type: 'TRANSFER',
        status: 'FAILED',
        failureCode: err.code,
        failureMessage: err.message,
        amount,
        fromAccount,
        toAccount,
        description,
      });
    } finally {
      el.transferSubmitBtn.disabled = false;
      el.transferSubmitBtn.innerHTML = '<span>Xác nhận chuyển tiền</span>';
    }
  }

  // Rút tiền
  async function handleWithdrawSubmit(e) {
    e.preventDefault();
    const fromAccount = el.withdrawFromAccount.value;
    const amount = parseInt(el.withdrawAmount.value, 10);
    const description = el.withdrawDescription.value.trim();

    if (!fromAccount || !amount) {
      showToast('Vui lòng điền đầy đủ thông tin bắt buộc', 'warning');
      return;
    }

    const idempotencyKey = generateUUID();

    try {
      el.withdrawSubmitBtn.disabled = true;
      el.withdrawSubmitBtn.innerHTML = '<span>Đang rút tiền...</span> ⏳';

      const res = await api('/api/transactions/withdraw', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: {
          fromAccount,
          amount,
          description: description || undefined,
        },
      });

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
      showToast(`Rút tiền không thành công: [${err.code || 'ERROR'}] ${err.message}`, 'error', 6000);
      showReceiptModal({
        title: 'Rút tiền thất bại',
        type: 'WITHDRAW',
        status: 'FAILED',
        failureCode: err.code,
        failureMessage: err.message,
        amount,
        fromAccount,
        description,
      });
    } finally {
      el.withdrawSubmitBtn.disabled = false;
      el.withdrawSubmitBtn.innerHTML = '<span>Xác nhận rút tiền</span>';
    }
  }

  // Nạp tiền (ADMIN)
  async function handleDepositSubmit(e) {
    e.preventDefault();
    const toAccount = el.depositToAccount.value.trim();
    const amount = parseInt(el.depositAmount.value, 10);
    const description = el.depositDescription.value.trim();

    if (!toAccount || !amount) {
      showToast('Vui lòng điền đầy đủ thông tin bắt buộc', 'warning');
      return;
    }

    const idempotencyKey = generateUUID();

    try {
      el.depositSubmitBtn.disabled = true;
      el.depositSubmitBtn.innerHTML = '<span>Đang nạp tiền...</span> ⏳';

      const res = await api('/api/transactions/deposit', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey,
        },
        body: {
          toAccount,
          amount,
          description: description || undefined,
        },
      });

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
      showToast(`Nạp tiền thất bại: [${err.code || 'ERROR'}] ${err.message}`, 'error', 6000);
      showReceiptModal({
        title: 'Nạp tiền thất bại',
        type: 'DEPOSIT',
        status: 'FAILED',
        failureCode: err.code,
        failureMessage: err.message,
        amount,
        toAccount,
        description,
      });
    } finally {
      el.depositSubmitBtn.disabled = false;
      el.depositSubmitBtn.innerHTML = '<span>Xác nhận nạp tiền</span>';
    }
  }

  // --- 8. HISTORY & STATEMENTS (TRANSACTIONS & POSTINGS) ---

  async function loadHistory() {
    const mode = STATE.history.mode;
    const account = el.historyAccountSelect.value || '';
    const page = STATE.history.page;
    const size = STATE.history.size;

    if (mode === 'postings' && !account) {
      el.historyTableHead.innerHTML = '';
      el.historyTableBody.innerHTML = `
        <tr><td colspan="6" class="text-center empty-message">
          Vui lòng chọn một số tài khoản cụ thể để xem sao kê sổ cái (Postings).
        </td></tr>`;
      el.paginationBar.classList.add('hidden');
      return;
    }

    try {
      el.historyTableBody.innerHTML = `
        <tr><td colspan="7" class="text-center empty-message">Đang tải dữ liệu...</td></tr>`;

      if (mode === 'transactions') {
        const query = new URLSearchParams({ page, size });
        if (account) query.append('account', account);

        const data = await api(`/api/transactions?${query.toString()}`);
        renderTransactionsTable(data || []);
      } else {
        const query = new URLSearchParams({ page, size });
        const data = await api(`/api/accounts/${account}/postings?${query.toString()}`);
        renderPostingsTable(data || []);
      }
    } catch (err) {
      if (err.message !== 'UNAUTHORIZED') {
        el.historyTableBody.innerHTML = `
          <tr><td colspan="7" class="text-center empty-message">Lỗi tải dữ liệu: ${err.message}</td></tr>`;
      }
    }
  }

  function renderTransactionsTable(transactions) {
    el.historyTableHead.innerHTML = `
      <tr>
        <th>Thời gian</th>
        <th>Loại giao dịch</th>
        <th>Tài khoản nguồn</th>
        <th>Tài khoản đích</th>
        <th>Số tiền</th>
        <th>Trạng thái</th>
        <th>Nội dung</th>
      </tr>
    `;

    if (transactions.length === 0) {
      el.historyTableBody.innerHTML = `
        <tr><td colspan="7" class="text-center empty-message">Chưa có giao dịch nào được ghi nhận.</td></tr>`;
      el.paginationBar.classList.add('hidden');
      return;
    }

    el.historyTableBody.innerHTML = transactions
      .map((t) => {
        let typeBadge = '';
        if (t.type === 'DEPOSIT') typeBadge = '<span class="badge badge-completed">Nạp tiền</span>';
        else if (t.type === 'WITHDRAW') typeBadge = '<span class="badge badge-frozen">Rút tiền</span>';
        else typeBadge = '<span class="badge badge-customer">Chuyển khoản</span>';

        const statusClass = (t.status || '').toLowerCase();
        return `
          <tr>
            <td>${formatDateTime(t.createdAt)}</td>
            <td>${typeBadge}</td>
            <td><code>${t.fromAccount || '—'}</code></td>
            <td><code>${t.toAccount || '—'}</code></td>
            <td><strong>${formatCurrency(t.amount)}</strong></td>
            <td><span class="badge badge-${statusClass}">${t.status}</span></td>
            <td>${t.description || '—'}</td>
          </tr>
        `;
      })
      .join('');

    updatePaginationBar(transactions.length);
  }

  function renderPostingsTable(postings) {
    el.historyTableHead.innerHTML = `
      <tr>
        <th>Thời gian</th>
        <th>Số tiền phát sinh</th>
        <th>Số dư sau giao dịch</th>
        <th>Nội dung</th>
        <th>Mã giao dịch (Txn ID)</th>
      </tr>
    `;

    if (postings.length === 0) {
      el.historyTableBody.innerHTML = `
        <tr><td colspan="5" class="text-center empty-message">Chưa có bút toán sổ cái nào cho tài khoản này.</td></tr>`;
      el.paginationBar.classList.add('hidden');
      return;
    }

    el.historyTableBody.innerHTML = postings
      .map((p) => {
        const amt = Number(p.amount);
        const amtDisplay = amt > 0
          ? `<span class="amount-plus">+${formatCurrency(amt)}</span>`
          : `<span class="amount-minus">${formatCurrency(amt)}</span>`;

        return `
          <tr>
            <td>${formatDateTime(p.createdAt)}</td>
            <td>${amtDisplay}</td>
            <td><strong>${formatCurrency(p.balanceAfter)}</strong></td>
            <td>${p.description || '—'}</td>
            <td><code title="${p.transactionId}">${p.transactionId.substring(0, 8)}...</code></td>
          </tr>
        `;
      })
      .join('');

    updatePaginationBar(postings.length);
  }

  function updatePaginationBar(itemCount) {
    el.paginationBar.classList.remove('hidden');
    el.pageIndicator.textContent = `Trang ${STATE.history.page}`;
    el.prevPageBtn.disabled = STATE.history.page <= 1;
    el.nextPageBtn.disabled = itemCount < STATE.history.size;
  }

  // --- 9. MODALS LOGIC ---

  function showReceiptModal(data) {
    const isSuccess = data.status === 'COMPLETED' || data.status === 'PENDING';
    el.receiptModalTitle.textContent = data.title || 'Biên lai giao dịch';

    let statusBanner = '';
    if (isSuccess) {
      statusBanner = `
        <div class="receipt-status-banner success">
          <h3>✅ Giao dịch ${data.status === 'COMPLETED' ? 'Thành công' : 'Đang xử lý'}</h3>
          <p style="font-size: 1.5rem; font-weight: 700; margin-top: 0.25rem;">
            ${formatCurrency(data.amount)}
          </p>
        </div>`;
    } else {
      statusBanner = `
        <div class="receipt-status-banner failed">
          <h3>❌ Giao dịch Thất bại</h3>
          <p style="font-weight: 600; margin-top: 0.25rem;">
            [${data.failureCode || 'ERROR'}] ${data.failureMessage || 'Giao dịch không thành công'}
          </p>
        </div>`;
    }

    let rowsHtml = '';
    if (data.id) {
      rowsHtml += `
        <div class="receipt-row">
          <span class="receipt-row-label">Mã giao dịch:</span>
          <span class="receipt-row-value"><code>${data.id}</code></span>
        </div>`;
    }
    if (data.fromAccount) {
      rowsHtml += `
        <div class="receipt-row">
          <span class="receipt-row-label">Tài khoản trích tiền:</span>
          <span class="receipt-row-value"><code>${data.fromAccount}</code></span>
        </div>`;
    }
    if (data.toAccount) {
      rowsHtml += `
        <div class="receipt-row">
          <span class="receipt-row-label">Tài khoản thụ hưởng:</span>
          <span class="receipt-row-value"><code>${data.toAccount}</code></span>
        </div>`;
    }
    if (data.description) {
      rowsHtml += `
        <div class="receipt-row">
          <span class="receipt-row-label">Nội dung:</span>
          <span class="receipt-row-value">${data.description}</span>
        </div>`;
    }
    if (data.createdAt) {
      rowsHtml += `
        <div class="receipt-row">
          <span class="receipt-row-label">Thời gian:</span>
          <span class="receipt-row-value">${formatDateTime(data.createdAt)}</span>
        </div>`;
    }

    el.receiptModalBody.innerHTML = `
      <div class="receipt-box">
        ${statusBanner}
        ${rowsHtml}
      </div>
    `;

    el.receiptModal.classList.remove('hidden');
  }

  function openStatusModal(accountNumber, currentStatus) {
    STATE.targetStatusAccount = accountNumber;
    el.statusTargetAccountDisplay.textContent = accountNumber;
    el.newStatusSelect.value = currentStatus || 'ACTIVE';
    el.statusModal.classList.remove('hidden');
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

      showToast(`Đã cập nhật tài khoản ${STATE.targetStatusAccount} sang trạng thái ${newStatus}`, 'success');
      el.statusModal.classList.add('hidden');
      await loadAccounts();
    } catch (err) {
      showToast(`Lỗi đổi trạng thái: ${err.message}`, 'error');
    } finally {
      el.submitStatusBtn.disabled = false;
    }
  }

  // --- 10. EVENT LISTENERS & SETUP ---

  function setupEventListeners() {
    // Auth Tab Switchers
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

    // Quick demo buttons
    document.querySelectorAll('.demo-fill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.loginUsername.value = btn.dataset.user;
        el.loginPassword.value = btn.dataset.pass;
      });
    });

    // Login Form Submit
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
        showToast(`Đăng nhập thất bại: [${err.code || 'AUTH_ERR'}] ${err.message}`, 'error');
      } finally {
        el.loginSubmitBtn.disabled = false;
        el.loginSubmitBtn.textContent = 'Đăng nhập';
      }
    });

    // Register Form Submit
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
        el.registerSubmitBtn.textContent = 'Đang xử lý đăng ký...';

        const res = await api('/api/auth/register', {
          method: 'POST',
          body: { username, password, fullName, idNumber, phone, email },
        });

        showToast('Đăng ký tài khoản thành công! Tự động đăng nhập...', 'success');
        handleLoginSuccess(res.token, res.user);
      } catch (err) {
        showToast(`Đăng ký thất bại: [${err.code || 'REG_ERR'}] ${err.message}`, 'error');
      } finally {
        el.registerSubmitBtn.disabled = false;
        el.registerSubmitBtn.textContent = 'Đăng ký tài khoản';
      }
    });

    // Logout
    el.logoutBtn.addEventListener('click', () => handleLogout(true));

    // Dashboard Nav Tab Switchers
    el.navTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        switchDashboardTab(tab.dataset.tab);
      });
    });

    // Accounts tab actions
    el.openAccountBtn.addEventListener('click', handleOpenAccount);
    el.refreshAccountsBtn.addEventListener('click', loadAccounts);

    // Dynamic balance hints on source account select
    el.transferFromAccount.addEventListener('change', () => {
      const selected = el.transferFromAccount.options[el.transferFromAccount.selectedIndex];
      if (selected && selected.dataset.balance) {
        el.transferSourceBalanceHint.textContent = `Số dư khả dụng: ${formatCurrency(selected.dataset.balance)}`;
      } else {
        el.transferSourceBalanceHint.textContent = '';
      }
    });

    el.withdrawFromAccount.addEventListener('change', () => {
      const selected = el.withdrawFromAccount.options[el.withdrawFromAccount.selectedIndex];
      if (selected && selected.dataset.balance) {
        el.withdrawSourceBalanceHint.textContent = `Số dư khả dụng: ${formatCurrency(selected.dataset.balance)}`;
      } else {
        el.withdrawSourceBalanceHint.textContent = '';
      }
    });

    // Quick pick amounts
    document.querySelectorAll('.quick-amount-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetInput = document.getElementById(btn.dataset.target);
        if (targetInput) targetInput.value = btn.dataset.val;
      });
    });

    // Forms
    el.transferForm.addEventListener('submit', handleTransferSubmit);
    el.withdrawForm.addEventListener('submit', handleWithdrawSubmit);
    el.depositForm.addEventListener('submit', handleDepositSubmit);

    // History controls
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

  // --- 11. INITIALIZATION ---
  setupEventListeners();
  updateAuthUI();

})();
