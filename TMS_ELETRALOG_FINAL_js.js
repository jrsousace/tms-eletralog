/* --- CONFIGURAÇÃO GLOBAL --- */
const SYSTEM_DATE_STR = new Date().toISOString().split('T')[0]; 
let CURRENT_USER = null;

const ROLE_PERMISSIONS = {
    'MASTER':   { level: 4, label: 'Diretoria', canManageUsers: true, canDeleteAny: true },
    'GESTOR':   { level: 3, label: 'Gestor Logística', canManageUsers: true, canDeleteAny: true },
    'USER':     { level: 2, label: 'Analista/Operador', canManageUsers: false, canDeleteAny: false },
    'TERCEIRO': { level: 1, label: 'Transportadora/Portaria', canManageUsers: false, canDeleteAny: false }
};

/* --- SISTEMA DE SESSÃO --- */
function checkSession() {
    const session = localStorage.getItem('eletra_session');
    if (!session) { window.location.href = 'login.html'; return; }
    CURRENT_USER = JSON.parse(session);
}
checkSession();

function doLogout() {
    if(confirm("Deseja realmente sair?")) {
        localStorage.removeItem('eletra_session');
        window.location.href = 'login.html';
    }
}

/* --- GERENCIADOR DE DADOS (FIREBASE - NUVEM) --- */
const StorageManager = {
    // Busca dados da coleção 'agendamentos'
    getAppointments: async function() {
        try {
            const snapshot = await db.collection('agendamentos').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) {
            console.error("Erro ao buscar agendamentos:", e);
            return [];
        }
    },

    // Busca dados da coleção 'logs'
    getLogs: async function() {
        try {
            const snapshot = await db.collection('logs').orderBy('timestamp', 'desc').limit(100).get();
            return snapshot.docs.map(doc => doc.data());
        } catch (e) { return []; }
    },

    // Busca usuários
    getUsers: async function() {
        try {
            const snapshot = await db.collection('usuarios').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },

    saveAppointments: async function(newAppts) {
        const batch = db.batch(); 
        newAppts.forEach(appt => {
            const docRef = db.collection('agendamentos').doc(); 
            batch.set(docRef, appt);
        });
        await batch.commit();
    },

    cancelAppointment: async function(date, time, location) {
        const snapshot = await db.collection('agendamentos')
            .where('date', '==', date)
            .where('time', '==', time)
            .where('location', '==', location)
            .get();

        if (snapshot.empty) return { success: false, msg: "Agendamento não encontrado." };

        const doc = snapshot.docs[0];
        const appt = doc.data();
        const userRole = ROLE_PERMISSIONS[CURRENT_USER.role];

        if (userRole.level === 1) return { success: false, msg: "Perfil de Terceiro: Apenas Leitura." };
        if (!userRole.canDeleteAny && appt.userId !== CURRENT_USER.id) {
            return { success: false, msg: "Permissão negada." };
        }

        await db.collection('agendamentos').doc(doc.id).delete();
        this.logAction("CANCELAMENTO", `Liberado: ${date} ${time} - ${location} por ${CURRENT_USER.name}`);
        return { success: true };
    },

    saveUser: async function(newUser) {
        const check = await db.collection('usuarios').where('user', '==', newUser.user).get();
        if (!check.empty) return { success: false, msg: "Login já existe." };
        await db.collection('usuarios').add(newUser);
        return { success: true };
    },

    deleteUser: async function(userId) {
        const snapshot = await db.collection('usuarios').where('id', '==', userId).get();
        if (snapshot.empty) return { success: false, msg: "Usuário não encontrado." };
        
        const doc = snapshot.docs[0];
        if (doc.data().role === 'MASTER') return { success: false, msg: "Não pode excluir Master." };
        
        await db.collection('usuarios').doc(doc.id).delete();
        return { success: true };
    },

    // --- MÓDULO TRANSPORTADORAS ---
    getTransportadoras: async function() {
        try {
            const snapshot = await db.collection('transportadoras').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    
    // Busca uma única transportadora pelo ID (Para Edição)
    getTransportadoraById: async function(id) {
        try {
            const doc = await db.collection('transportadoras').doc(id).get();
            return doc.exists ? { id_doc: doc.id, ...doc.data() } : null;
        } catch (e) { return null; }
    },

    saveTransportadora: async function(transp) {
        const check = await db.collection('transportadoras').where('cnpj', '==', transp.cnpj).get();
        if (!check.empty) return { success: false, msg: "CNPJ já cadastrado no sistema." };
        await db.collection('transportadoras').add(transp);
        this.logAction("CADASTRO", `Nova Transportadora: ${transp.razao}`);
        return { success: true };
    },

    updateTransportadora: async function(id, transp) {
        try {
            await db.collection('transportadoras').doc(id).update(transp);
            this.logAction("EDIÇÃO", `Transportadora atualizada: ${transp.razao}`);
            return { success: true };
        } catch(e) {
            return { success: false, msg: "Erro ao atualizar." };
        }
    },

    deleteTransportadora: async function(id_doc) {
        await db.collection('transportadoras').doc(id_doc).delete();
        return { success: true };
    },
    // ---------------------------------

    logAction: function(action, details) {
        db.collection('logs').add({
            timestamp: new Date().toISOString(),
            user: CURRENT_USER.name,
            action: action,
            details: details
        });
    },

    clearData: async function() {
        alert("Limpeza global desativada na versão online por segurança.");
    }
};

/* --- UI PRINCIPAL --- */
window.onload = function() {
    if(CURRENT_USER) {
        document.getElementById('user-display').innerHTML = `${CURRENT_USER.name} <br><span style="font-size:0.6rem; color:#888;">${ROLE_PERMISSIONS[CURRENT_USER.role].label}</span>`;
    }
    goHome();
};

function toggleModule(id) {
    const el = document.getElementById(id);
    const isActive = el.classList.contains('active');
    document.querySelectorAll('.module-group').forEach(g => g.classList.remove('active'));
    if (!isActive) el.classList.add('active');
}
function switchTab(tabId) {
    const content = document.querySelectorAll('.tab-content');
    const btns = document.querySelectorAll('.tab-btn');
    content.forEach(c => c.classList.remove('active'));
    btns.forEach(b => b.classList.remove('active'));
    const target = document.getElementById(tabId);
    if(target) target.classList.add('active');
    if(event && event.currentTarget) event.currentTarget.classList.add('active');
}

/* --- FUNÇÕES ASSÍNCRONAS DE CARGA --- */
async function goHome() {
    const appts = await StorageManager.getAppointments();
    const count = appts.length;
    document.getElementById('view-title').innerText = "Dashboard Principal";
    document.getElementById('view-breadcrumb').innerText = "Sistemas Eletra Energy";
    document.getElementById('workspace').innerHTML = `
        <div class="card">
            <h3 style="color: white; margin-bottom: 15px;">Bem-vindo, ${CURRENT_USER.name.split(' ')[0]}</h3>
            <div class="marking-group">
                <button class="mark-btn selected">Agendamentos Ativos: ${count}</button>
            </div>
        </div>`;
    document.querySelectorAll('.module-group').forEach(g => g.classList.remove('active'));
}

function loadPage(page, module) {
    const workspace = document.getElementById('workspace');
    document.getElementById('view-title').innerText = page;
    document.getElementById('view-breadcrumb').innerText = module + " > " + page;

    if (page === 'Transportadora') { renderTransportadora(workspace); }
    else if (page === 'Agendamentos') { renderAgendamentos(workspace); } 
    else if (page === 'Logs do Sistema') { renderLogsPage(workspace); }
    else if (page === 'Perfis e Permissões') { renderUsersPage(workspace); }
    else { workspace.innerHTML = `<div class="card"><h3>${page}</h3><p>Em desenvolvimento.</p></div>`; }
}

/* --- MÓDULO TRANSPORTADORA (FUNCIONAL E INTEGRADO) --- */
async function renderTransportadora(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Apenas Gestores e Master podem cadastrar transportadoras.</p></div>`;
        return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando banco de transportadoras...</div>';
    
    // Busca a lista no Firebase
    const transps = await StorageManager.getTransportadoras();
    
    let rows = transps.map(t => `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">${t.cnpj}</td>
            <td><strong>${t.razao}</strong><br><span style="font-size:0.7rem; color:#888;">${t.fantasia || ''}</span></td>
            <td>${t.contatoNome}<br><span style="font-size:0.7rem;">${t.contatoTel}</span></td>
            <td>${t.rntrcValidade}<br><span style="font-size:0.7rem; color:${new Date(t.rntrcValidade) < new Date() ? '#FF3131' : '#00D4FF'}">RNTRC</span></td>
            <td style="font-size:0.7rem;">RCTR-C: ${t.seguros?.rctrc?.seguradora || '-'}<br>Frota: ${t.frotaPropriaPct || '0'}%</td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:2px 8px; margin-right:5px;" onclick="handleEditTransportadora('${t.id_doc}')" title="Editar"><i class="fa-solid fa-pen"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:2px 8px;" onclick="handleDeleteTransportadora('${t.id_doc}')" title="Apagar"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    if (transps.length === 0) rows = `<tr><td colspan="6" style="text-align:center; padding:15px; font-style:italic;">Nenhuma parceira cadastrada.</td></tr>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" id="tab-geral-btn" onclick="switchTab('geral')">Geral / Seguros / Operacional</button>
                <button class="tab-btn" onclick="switchTab('lista-transp')" style="color:var(--eletra-orange)">Cadastradas (${transps.length})</button>
            </div>
            
            <div id="geral" class="tab-content active" style="position:relative;">
                <div id="status-card" class="status-neon active">NOVO CADASTRO</div>
                
                <input type="hidden" id="t-id-doc">

                <div class="form-row"><label>CNPJ*:</label><input type="text" id="t-cnpj" placeholder="Digite apenas números"></div>
                <div class="form-row"><label>Razão Social*:</label><input type="text" id="t-razao" placeholder="Nome oficial na Receita Federal"></div>
                <div class="form-row"><label>Nome Fantasia:</label><input type="text" id="t-fantasia" placeholder="Nome comercial"></div>
                
                <fieldset class="prop-group">
                    <legend>CONTATO OPERACIONAL</legend>
                    <div class="form-row">
                        <label>Nome do Contato:</label><input type="text" id="t-contato-nome" placeholder="Ex: João Silva">
                        <label style="width:70px; text-align:right; margin-right:10px;">Telefone:</label><input type="text" id="t-contato-tel" placeholder="(11) 99999-9999">
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>ANTT & FROTA</legend>
                    <div class="form-row"><label>RNTRC:</label><input type="text" id="t-rntrc" style="width:40%"><label style="width:60px; text-align:right">Validade:</label><input type="date" id="t-val-rntrc" value="${SYSTEM_DATE_STR}" onchange="validateTranspDates()"></div>
                    <div class="form-row"><label>% Frota Própria:</label><input type="number" id="t-frota" placeholder="Ex: 60"></div>
                    <div class="form-row"><label>Idade Média (Anos):</label><input type="number" id="t-idade" placeholder="Ex: 5"></div>
                </fieldset>
                
                <fieldset class="prop-group"><legend>ZONAS DE ATUAÇÃO</legend><div class="marking-group">${['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'].map(uf => `<button class="mark-btn zone-btn selected" onclick="this.classList.toggle('selected')">${uf}</button>`).join('')}</div></fieldset>
                
                <fieldset class="prop-group">
                    <legend>APÓLICES DE SEGURO</legend>
                    <div class="form-row"><label style="width:130px; font-size:0.7rem;">RCTR-C:</label><input type="text" id="t-rctrc" placeholder="Apólice" style="width:20%"><input type="text" id="t-seg-rctrc" placeholder="Seguradora" style="width:30%"><input type="date" id="t-val-rctrc" value="${SYSTEM_DATE_STR}" onchange="validateTranspDates()"></div>
                    <div class="form-row"><label style="width:130px; font-size:0.7rem;">RC-DC:</label><input type="text" id="t-rcdc" placeholder="Apólice" style="width:20%"><input type="text" id="t-seg-rcdc" placeholder="Seguradora" style="width:30%"><input type="date" id="t-val-rcdc" value="${SYSTEM_DATE_STR}" onchange="validateTranspDates()"></div>
                    <div class="form-row"><label style="width:130px; font-size:0.7rem;">RC-V:</label><input type="text" id="t-rcv" placeholder="Apólice" style="width:20%"><input type="text" id="t-seg-rcv" placeholder="Seguradora" style="width:30%"><input type="date" id="t-val-rcv" value="${SYSTEM_DATE_STR}" onchange="validateTranspDates()"></div>
                </fieldset>

                <div class="props-footer" style="margin-top: 20px;">
                    <button id="btn-save-transp" class="mark-btn action apply" onclick="handleSaveTransportadora()">SALVAR CADASTRO</button>
                    <button class="mark-btn action" onclick="cancelEditMode()">CANCELAR</button>
                </div>
            </div>

            <div id="lista-transp" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>CNPJ</th><th>Razão / Fantasia</th><th>Contato</th><th>RNTRC</th><th>Detalhes</th><th>Ações</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
    
    validateTranspDates();
}

function validateTranspDates() {
    const sysDate = new Date(SYSTEM_DATE_STR);
    const ids = ['t-val-rntrc', 't-val-rctrc', 't-val-rcdc', 't-val-rcv'];
    let expired = false;
    
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        if (new Date(el.value) < sysDate) { el.classList.add('input-error'); expired = true; }
        else { el.classList.remove('input-error'); }
    });
    
    const status = document.getElementById('status-card');
    if (status) {
        if (expired) { 
            status.innerText = "ATENÇÃO: DOC VENCIDO"; status.className = "status-neon inactive"; 
        } else { 
            // Mantém o texto "EM EDIÇÃO" se estiver editando, senão "NOVO" ou "OK"
            if (!status.innerText.includes("EDIÇÃO") && !status.innerText.includes("NOVO")) {
                status.innerText = "DOCUMENTAÇÃO OK"; 
            }
            status.className = "status-neon active"; 
        }
    }
}

async function handleSaveTransportadora() {
    const idDoc = document.getElementById('t-id-doc').value; // Verifica se é edição
    const cnpj = document.getElementById('t-cnpj').value.trim();
    const razao = document.getElementById('t-razao').value.trim();

    if (!cnpj || !razao) { notify("CNPJ e Razão Social são obrigatórios!", "error"); return; }

    const zonasAtivas = Array.from(document.querySelectorAll('.zone-btn.selected')).map(btn => btn.innerText);

    const dataPayload = {
        cnpj: cnpj,
        razao: razao,
        fantasia: document.getElementById('t-fantasia').value.trim(),
        contatoNome: document.getElementById('t-contato-nome').value.trim(),
        contatoTel: document.getElementById('t-contato-tel').value.trim(),
        rntrc: document.getElementById('t-rntrc').value.trim(),
        rntrcValidade: document.getElementById('t-val-rntrc').value,
        seguros: {
            rctrc: { apolice: document.getElementById('t-rctrc').value.trim(), seguradora: document.getElementById('t-seg-rctrc').value.trim(), validade: document.getElementById('t-val-rctrc').value },
            rcdc: { apolice: document.getElementById('t-rcdc').value.trim(), seguradora: document.getElementById('t-seg-rcdc').value.trim(), validade: document.getElementById('t-val-rcdc').value },
            rcv: { apolice: document.getElementById('t-rcv').value.trim(), seguradora: document.getElementById('t-seg-rcv').value.trim(), validade: document.getElementById('t-val-rcv').value }
        },
        frotaPropriaPct: document.getElementById('t-frota').value.trim(),
        idadeMedia: document.getElementById('t-idade').value.trim(),
        zonas: zonasAtivas,
        cadastradoPor: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    if (idDoc) {
        // MODO ATUALIZAÇÃO
        if (!confirm(`Confirma a atualização dos dados de ${razao}?`)) return;
        const res = await StorageManager.updateTransportadora(idDoc, dataPayload);
        if (res.success) {
            notify("Atualizado com sucesso!");
            renderTransportadora(document.getElementById('workspace'));
        } else {
            notify(res.msg, "error");
        }
    } else {
        // MODO CRIAÇÃO (NOVO)
        if (!confirm(`Confirma o cadastro de ${razao}?`)) return;
        const res = await StorageManager.saveTransportadora(dataPayload);
        if (res.success) {
            notify("Salvo com sucesso!");
            renderTransportadora(document.getElementById('workspace'));
        } else {
            notify(res.msg, "error");
        }
    }
}

async function handleEditTransportadora(id) {
    const t = await StorageManager.getTransportadoraById(id);
    if (!t) { notify("Erro ao carregar dados.", "error"); return; }

    // Preenche os campos
    document.getElementById('t-id-doc').value = t.id_doc;
    document.getElementById('t-cnpj').value = t.cnpj;
    document.getElementById('t-razao').value = t.razao;
    document.getElementById('t-fantasia').value = t.fantasia || '';
    document.getElementById('t-contato-nome').value = t.contatoNome || '';
    document.getElementById('t-contato-tel').value = t.contatoTel || '';
    
    document.getElementById('t-rntrc').value = t.rntrc || '';
    document.getElementById('t-val-rntrc').value = t.rntrcValidade;
    document.getElementById('t-frota').value = t.frotaPropriaPct || '';
    document.getElementById('t-idade').value = t.idadeMedia || '';

    // Seguros
    if(t.seguros) {
        if(t.seguros.rctrc) {
            document.getElementById('t-rctrc').value = t.seguros.rctrc.apolice || '';
            document.getElementById('t-seg-rctrc').value = t.seguros.rctrc.seguradora || '';
            document.getElementById('t-val-rctrc').value = t.seguros.rctrc.validade;
        }
        if(t.seguros.rcdc) {
            document.getElementById('t-rcdc').value = t.seguros.rcdc.apolice || '';
            document.getElementById('t-seg-rcdc').value = t.seguros.rcdc.seguradora || '';
            document.getElementById('t-val-rcdc').value = t.seguros.rcdc.validade;
        }
        if(t.seguros.rcv) {
            document.getElementById('t-rcv').value = t.seguros.rcv.apolice || '';
            document.getElementById('t-seg-rcv').value = t.seguros.rcv.seguradora || '';
            document.getElementById('t-val-rcv').value = t.seguros.rcv.validade;
        }
    }

    // Zonas
    document.querySelectorAll('.zone-btn').forEach(btn => {
        if (t.zonas && t.zonas.includes(btn.innerText)) btn.classList.add('selected');
        else btn.classList.remove('selected');
    });

    // Ajusta UI para modo edição
    document.getElementById('status-card').innerText = "EM EDIÇÃO";
    document.getElementById('status-card').className = "status-neon active";
    document.getElementById('btn-save-transp').innerText = "ATUALIZAR DADOS";
    document.getElementById('btn-save-transp').style.color = "var(--eletra-orange)";
    document.getElementById('btn-save-transp').style.borderColor = "var(--eletra-orange)";
    
    // Troca para a aba Geral
    switchTab('geral');
    validateTranspDates(); // Revalida as datas carregadas
    notify("Modo de edição ativado.", "info");
}

function cancelEditMode() {
    renderTransportadora(document.getElementById('workspace'));
}

async function handleDeleteTransportadora(id_doc) {
    if (!confirm("Deseja realmente excluir esta transportadora? Essa ação afeta relatórios futuros.")) return;
    const res = await StorageManager.deleteTransportadora(id_doc);
    if (res.success) {
        notify("Transportadora excluída.");
        renderTransportadora(document.getElementById('workspace')); // Atualiza a tela
    }
}

/* --- AGENDAMENTOS (LÓGICA ASSÍNCRONA) --- */
let selectedSlots = [];

function renderAgendamentos(container) {
    const isReadOnly = (ROLE_PERMISSIONS[CURRENT_USER.role].level === 1);
    
    container.innerHTML = `
        <div class="props-container">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('inbound')">Inbound</button>
                <button class="tab-btn" onclick="switchTab('outbound')">Outbound</button>
                <button class="tab-btn" onclick="switchTab('transfer')">Transfer</button>
            </div>
            <div id="inbound" class="tab-content active">
                ${isReadOnly ? '<div style="background:#333; color:#FF8200; padding:5px; font-size:0.7rem; text-align:center; margin-bottom:10px;">MODO LEITURA</div>' : ''}
                <fieldset class="prop-group" ${isReadOnly ? 'disabled' : ''}>
                    <legend>Check-in</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">Pedido Compra (Mat)*:</label><input type="text" id="input-po-mat"></div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">NF Material*:</label><input type="text" id="input-nf"></div>
                            <div class="form-row"><label>Fornecedor:</label><input type="text" id="input-fornecedor"></div>
                            <div class="form-row"><label>CNPJ Fornec.:</label><input type="text" id="input-cnpj-fornecedor"></div>
                            <div class="form-row"><label>Solicitante:</label><input type="text" id="input-solicitante"></div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">Comprador*:</label><input type="text" id="input-comprador"></div>
                        </div>
                        <div>
                            <div class="form-row"><label>Transportadora:</label><input type="text" id="input-transp"></div>
                            <div class="form-row"><label>CNPJ Transp.:</label><input type="text" id="input-cnpj-transp"></div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">Pedido Frete*:</label><input type="text" id="input-po-frete"></div>
                            <div class="form-row"><label>CTRC:</label><input type="text" id="input-ctrc"></div>
                            
                            <div class="form-row"><label>Tipo Veículo:</label>
                                <select id="input-tipo-veiculo">
                                    <option value="">Selecione...</option>
                                    <option value="Moto">Moto</option>
                                    <option value="Passeio">Passeio</option>
                                    <option value="Caminhonete">Caminhonete</option>
                                    <option value="Pickup">Pickup</option>
                                    <option value="Utilitário">Utilitário</option>
                                    <option value="VUC">VUC</option>
                                    <option value="3/4">3/4</option>
                                    <option value="Toco">Toco</option>
                                    <option value="Truck">Truck</option>
                                    <option value="Carreta">Carreta</option>
                                    <option value="Container">Container</option>
                                </select>
                            </div>
                            <div class="form-row"><label>Observações:</label><input type="text" id="input-obs" placeholder="Ex: Descarga lateral..."></div>

                        </div>
                    </div>
                </fieldset>
                <fieldset class="prop-group">
                    <legend>Alocação</legend>
                    <div class="form-row"><label>Local:</label><select id="loc" onchange="updateInboundSlots()"><option value="Doca">Doca</option><option value="Portaria">Portaria</option></select></div>
                    <div class="form-row"><label>Data:</label><input type="date" id="in-date" value="${SYSTEM_DATE_STR}" onchange="updateInboundSlots()"></div>
                    <div class="slot-grid" id="inbound-slots" style="max-height: 250px; overflow-y: auto;"></div>
                </fieldset>
                <div style="margin-top: 10px; display: flex; justify-content: space-between;">
                    <button class="mark-btn" onclick="toggleLogPanel()"><i class="fa-solid fa-list"></i> Logs / Agenda</button>
                    <button class="mark-btn" onclick="printDailySchedule()"><i class="fa-solid fa-print"></i> Imprimir</button>
                </div>
                <div id="log-panel" style="display:none; margin-top:10px; background:#1a1d21; padding:10px; border-radius:4px; max-height:400px; overflow-y:auto; color:#aaa;"><div id="log-content"></div></div>
            </div>
            <div id="outbound" class="tab-content"><p style="padding:40px; text-align:center;">Outbound em construção.</p></div>
            <div id="transfer" class="tab-content"><p style="padding:40px; text-align:center;">Transfer em construção.</p></div>
            <div class="props-footer">
                ${!isReadOnly ? `<button class="mark-btn action" style="border-color:#FF3131; color:#FF3131;" onclick="handleLiberar()">LIBERAR</button>
                <button class="mark-btn action apply" onclick="saveBooking()">SALVAR</button>` : ''}
            </div>
        </div>`;
    updateInboundSlots();
}

async function updateInboundSlots() {
    const grid = document.getElementById('inbound-slots');
    if(!grid) return;
    
    grid.innerHTML = '<div style="color:white; padding:20px; text-align:center;">Carregando agenda...</div>';
    
    selectedSlots = [];
    const date = document.getElementById('in-date').value;
    const location = document.getElementById('loc').value;
    
    const allAppts = await StorageManager.getAppointments();
    const occupiedSlots = allAppts.filter(a => a.date === date && a.location === location);

    let html = '';
    for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 10) {
            let time = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
            const booking = occupiedSlots.find(b => b.time === time);
            
            let className = '';
            let clickAction = '';
            let tooltip = 'Livre';

            if (booking) {
                // Tratativa para evitar quebra de aspas nas observações
                const escObs = (booking.details.obs || '').replace(/'/g, "\\'");

                if (booking.userId === CURRENT_USER.id) {
                    className = 'my-booking'; 
                    clickAction = `toggleSlot(this, '${time}')`;
                    tooltip = `Meu: PO ${booking.details.poMat}`;
                } else {
                    className = 'occupied-by-others';
                    clickAction = `showBookingInfo('${booking.userName}', '${booking.details.poMat}', '${booking.details.comprador}', '${booking.timestamp}', '${booking.details.tipoVeiculo || ''}', '${escObs}')`;
                    tooltip = `Ocupado por: ${booking.userName}`;
                }
            } else {
                if(ROLE_PERMISSIONS[CURRENT_USER.role].level > 1) {
                    clickAction = `toggleSlot(this, '${time}')`;
                }
            }
            html += `<div class="time-slot ${className}" title="${tooltip}" onclick="${clickAction}">${time}</div>`;
        }
    }
    grid.innerHTML = html;
    updateLogPanel(date, location);
}

function toggleSlot(el, time) {
    if (el.classList.contains('occupied-by-others')) return;
    if (el.classList.contains('selected')) {
        el.classList.remove('selected');
        selectedSlots = selectedSlots.filter(s => s !== time);
    } else {
        el.classList.add('selected');
        selectedSlots.push(time);
    }
}

async function saveBooking() {
    const date = document.getElementById('in-date').value;
    const location = document.getElementById('loc').value;
    
    const poMat = document.getElementById('input-po-mat').value.trim();
    const nf = document.getElementById('input-nf').value.trim();
    const fornecedor = document.getElementById('input-fornecedor').value.trim();
    const cnpjFornecedor = document.getElementById('input-cnpj-fornecedor').value.trim();
    const solicitante = document.getElementById('input-solicitante').value.trim(); 
    const comprador = document.getElementById('input-comprador').value.trim();    
    const transp = document.getElementById('input-transp').value.trim();
    const cnpjTransp = document.getElementById('input-cnpj-transp').value.trim();
    const poFrete = document.getElementById('input-po-frete').value.trim();
    const ctrc = document.getElementById('input-ctrc').value.trim();
    
    // --- NOVO: LENDO DA TELA ---
    const tipoVeiculo = document.getElementById('input-tipo-veiculo').value; 
    const obs = document.getElementById('input-obs').value.trim();

    if (selectedSlots.length === 0) { notify("Selecione um horário.", "error"); return; }
    if (!poMat || !nf || !comprador || !poFrete) { notify("Preencha campos obrigatórios (*).", "error"); return; }

    const conflict = (await StorageManager.getAppointments()).find(a => a.date === date && a.location === location && selectedSlots.includes(a.time));
    if (conflict) { notify(`ERRO: Horário ${conflict.time} acabou de ser ocupado.`, "error"); updateInboundSlots(); return; }

    if (!confirm(`Confirmar agendamento?`)) return;

    const newBookings = selectedSlots.map(time => ({
        id: Date.now() + Math.random(),
        date, time, location,
        userId: CURRENT_USER.id,
        userName: CURRENT_USER.name,
        timestamp: new Date().toISOString(),
        // --- NOVO: ENVIANDO PARA O BANCO DE DADOS ---
        details: { poMat, nf, fornecedor, cnpjFornecedor, solicitante, comprador, transp, cnpjTransp, poFrete, ctrc, tipoVeiculo, obs }
    }));

    await StorageManager.saveAppointments(newBookings);
    StorageManager.logAction("INCLUSÃO", `Agendou ${selectedSlots.length} slots. PO: ${poMat}`);
    notify("Agendado com sucesso!");
    updateInboundSlots();
}

async function handleLiberar() {
    if (selectedSlots.length === 0) { notify("Selecione para liberar.", "error"); return; }
    if (!confirm(`Liberar ${selectedSlots.length} horários?`)) return;

    const date = document.getElementById('in-date').value;
    const location = document.getElementById('loc').value;
    let successCount = 0;
    
    for (const time of selectedSlots) {
        const res = await StorageManager.cancelAppointment(date, time, location);
        if(res.success) successCount++;
        else notify(res.msg, "error");
    }
    
    if (successCount > 0) { notify(`${successCount} liberados.`); updateInboundSlots(); }
}

/* --- GESTÃO DE USUÁRIOS --- */
async function renderUsersPage(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Sem permissão.</p></div>`;
        return;
    }

    container.innerHTML = '<div class="card">Carregando usuários...</div>';
    const users = await StorageManager.getUsers();
    
    let rows = users.map(u => `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">${u.matricula || '-'}</td>
            <td>${u.name}</td>
            <td>${u.cpf || '-'}</td>
            <td>${u.user}</td>
            <td><span class="badge ${u.role}">${u.role}</span></td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:2px 8px;" onclick="deleteUser('${u.id}')"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px;">
            <div class="tab-content active">
                <fieldset class="prop-group">
                    <legend>Novo Usuário</legend>
                    <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:10px;">
                        <div class="form-row-col"><label>Matrícula</label><input type="text" id="new-mat" oninput="generateAutoPass()"></div>
                        <div class="form-row-col" style="grid-column: span 2"><label>Nome Completo</label><input type="text" id="new-name" oninput="generateAutoPass()"></div>
                        <div class="form-row-col"><label>CPF</label><input type="text" id="new-cpf"></div>
                        <div class="form-row-col"><label>Login</label><input type="text" id="new-user"></div>
                        <div class="form-row-col"><label>Senha</label><input type="text" id="new-pass" readonly style="background:#222; color:#777;"></div>
                        <div class="form-row-col"><label>Perfil</label>
                            <select id="new-role">
                                <option value="USER">User (Operador)</option>
                                <option value="GESTOR">Gestor (Admin)</option>
                                <option value="MASTER">Master (Diretoria)</option>
                                <option value="TERCEIRO">Terceiro (Leitor)</option>
                            </select>
                        </div>
                        <div class="form-row-col" style="display:flex; align-items:flex-end;">
                            <button class="mark-btn action apply" onclick="createNewUser()" style="width:100%">CRIAR</button>
                        </div>
                    </div>
                </fieldset>
                <h4 style="margin-top:20px; color:var(--eletra-aqua); border-bottom:1px solid #333; padding-bottom:5px;">Base de Usuários</h4>
                <div style="overflow-x:auto;"><table class="data-table"><thead><tr><th>Matrícula</th><th>Nome</th><th>CPF</th><th>Login</th><th>Perfil</th><th>Ações</th></tr></thead><tbody>${rows}</tbody></table></div>
            </div>
        </div>`;
}

function generateAutoPass() {
    const mat = document.getElementById('new-mat').value.trim();
    const name = document.getElementById('new-name').value.trim();
    if (mat && name) {
        document.getElementById('new-pass').value = mat + name.split(' ').map(n => n[0]).join('').toUpperCase();
    }
}

async function createNewUser() {
    const matricula = document.getElementById('new-mat').value.trim();
    const name = document.getElementById('new-name').value.trim();
    const cpf = document.getElementById('new-cpf').value.trim();
    const user = document.getElementById('new-user').value.trim();
    const pass = document.getElementById('new-pass').value.trim();
    const role = document.getElementById('new-role').value;

    if (!matricula || !name || !cpf || !user || !pass) { notify("Preencha todos os campos.", "error"); return; }

    const newUser = { id: 'u_' + Date.now(), matricula, name, cpf, user, pass, role };
    const res = await StorageManager.saveUser(newUser);
    
    if (res.success) { notify("Usuário criado!"); renderUsersPage(document.getElementById('workspace')); }
    else { notify(res.msg, "error"); }
}

async function deleteUser(id) {
    if(!confirm("Confirmar exclusão?")) return;
    const res = await StorageManager.deleteUser(id);
    if (res.success) { notify("Excluído."); renderUsersPage(document.getElementById('workspace')); }
    else { notify(res.msg, "error"); }
}

/* --- LOGS E IMPRESSÃO (ASSÍNCRONO) --- */
function toggleLogPanel() { const p=document.getElementById('log-panel'); p.style.display=(p.style.display==='none')?'block':'none'; }

async function updateLogPanel(date, location) {
    const div = document.getElementById('log-content'); if(!div) return;
    div.innerHTML = "Carregando...";

    const allAppts = await StorageManager.getAppointments();
    const currentAppts = allAppts.filter(a => a.date===date && a.location===location).sort((a,b)=>a.time.localeCompare(b.time));
    
    let html = `<h4 style="color:var(--eletra-aqua); margin-bottom:5px; border-bottom:1px solid #444; font-size:0.75rem;">Agenda Vigente (${date} - ${location})</h4>`;
    
    if (currentAppts.length === 0) { html += `<div style="font-style:italic; color:#777; font-size:0.7rem;">Vazio.</div>`; } 
    else {
        currentAppts.forEach(a => { 
            const tipoDesc = a.details.tipoVeiculo ? ` | Veículo: ${a.details.tipoVeiculo}` : '';
            html += `<div style="border-bottom:1px solid #333; padding:2px 0; font-size:0.7rem;"><strong style="color:#fff;">${a.time}</strong> | Sol: ${a.details.solicitante||'-'} | Comp: ${a.details.comprador||'-'}${tipoDesc} | <span style="color:#888;">Agendado: ${a.userName}</span></div>`; 
        });
    }
    
    const allLogs = await StorageManager.getLogs();
    html += `<h4 style="color:var(--eletra-orange); margin-top:15px; margin-bottom:5px; border-top:1px solid #444; font-size:0.75rem;">Últimos Eventos</h4>`;
    allLogs.forEach(l => {
        html += `<div style="border-bottom:1px solid #333; padding:2px 0; font-family:monospace; font-size:0.65rem;"><span style="color:#666;">[${new Date(l.timestamp).toLocaleString('pt-BR')}]</span> <span style="color:${l.action.includes('CANCEL')?'#FF3131':'#00D4FF'}">${l.action}</span> ${l.user}: ${l.details}</div>`;
    });
    div.innerHTML = html;
}

// Funções de BI
async function renderLogsPage(container) {
    container.innerHTML = `
        <div class="props-container">
            <div class="props-tabs"><button class="tab-btn active">Logs / Auditoria</button></div>
            <div class="tab-content active">
                <div style="padding:10px;"><button class="mark-btn" onclick="refreshLogTables()">Atualizar</button></div>
                <div id="audit-table-area">Carregando...</div>
            </div>
        </div>`;
    refreshLogTables();
}

async function refreshLogTables() {
    const area = document.getElementById('audit-table-area');
    if(!area) return;
    const logs = await StorageManager.getLogs();
    let html = `<table class="data-table"><thead><tr><th>Data</th><th>Usuário</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>`;
    logs.forEach(l => {
        html += `<tr><td>${new Date(l.timestamp).toLocaleString()}</td><td>${l.user}</td><td>${l.action}</td><td>${l.details}</td></tr>`;
    });
    html += `</tbody></table>`;
    area.innerHTML = html;
}

async function printDailySchedule() {
    const date = document.getElementById('in-date').value;
    const allAppts = await StorageManager.getAppointments();
    const appts = allAppts.filter(a => a.date === date);
    if(appts.length === 0) { notify("Nada para imprimir."); return; }
    
    const doca = appts.filter(a => a.location === 'Doca').sort((a,b)=>a.time.localeCompare(b.time));
    const portaria = appts.filter(a => a.location === 'Portaria').sort((a,b)=>a.time.localeCompare(b.time));
    
    const generateRows = (list) => {
        if(list.length === 0) return '<tr><td colspan="7" style="text-align:center;">Vazio</td></tr>';
        return list.map(a => {
            const transpInfo = a.details.tipoVeiculo ? `${a.details.transp||'-'} (${a.details.tipoVeiculo})` : (a.details.transp||'-');
            return `<tr><td>${a.time}</td><td>${transpInfo}</td><td>${a.details.ctrc||'-'}</td><td>${a.details.solicitante||'-'}</td><td>${a.details.comprador||'-'}</td><td>${a.userName}</td><td>PO:${a.details.poMat}</td></tr>`
        }).join('');
    };

    const win = window.open('', '', 'height=800,width=950');
    win.document.write(`<html><head><title>Agenda</title><style>body{font-family:Arial;font-size:11px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:5px}th{background:#eee}</style></head><body><h1>Agenda ${date.split('-').reverse().join('/')}</h1><h2>DOCA</h2><table><thead><tr><th>Hora</th><th>Transp. (Veículo)</th><th>CTRC</th><th>Solic.</th><th>Comp.</th><th>Por</th><th>Ref</th></tr></thead><tbody>${generateRows(doca)}</tbody></table><h2>PORTARIA</h2><table><thead><tr><th>Hora</th><th>Transp. (Veículo)</th><th>CTRC</th><th>Solic.</th><th>Comp.</th><th>Por</th><th>Ref</th></tr></thead><tbody>${generateRows(portaria)}</tbody></table></body></html>`);
    win.document.close();
    win.print();
}

function notify(msg, type='success') {
    const bar = document.getElementById('notification-bar');
    const toast = document.createElement('div');
    toast.className = 'toast';
    if(type === 'error') toast.style.borderLeftColor = '#FF3131'; 
    if(type === 'info') toast.style.borderLeftColor = '#00D4FF'; 
    toast.innerHTML = `<i class="fa-solid fa-bell" style="margin-right:10px;"></i> ${msg}`;
    bar.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}
function handleEdit() { notify("Modo edição ativado."); }

function showBookingInfo(u,p,s,t,tipo,obs) { 
    // Busca direto do banco para pegar os dados completos, incluindo as novidades
    StorageManager.getAppointments().then(appts => {
        const appt = appts.find(a => a.timestamp === t);
        if(appt) {
            let msg = `🔒 ${appt.userName} | PO: ${appt.details.poMat} | Sol: ${appt.details.solicitante || '?'}`;
            if(appt.details.tipoVeiculo) msg += ` | Veíc: ${appt.details.tipoVeiculo}`;
            if(appt.details.obs) msg += ` | Obs: ${appt.details.obs}`;
            notify(msg, "info");
        }
    });
}
function clearData() { StorageManager.clearData(); }