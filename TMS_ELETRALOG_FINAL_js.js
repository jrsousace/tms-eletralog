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
    // --- MÓDULO EQUIPAMENTOS ---
    getEquipamentos: async function() {
        try {
            const snapshot = await db.collection('equipamentos').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    getEquipamentoById: async function(id) {
        try {
            const doc = await db.collection('equipamentos').doc(id).get();
            return doc.exists ? { id_doc: doc.id, ...doc.data() } : null;
        } catch (e) { return null; }
    },
    saveEquipamento: async function(equip) {
        // Evita placas duplicadas
        const check = await db.collection('equipamentos').where('placa', '==', equip.placa).get();
        if (!check.empty) return { success: false, msg: "Placa já cadastrada no sistema." };
        await db.collection('equipamentos').add(equip);
        return { success: true };
    },
    updateEquipamento: async function(id, equip) {
        try {
            await db.collection('equipamentos').doc(id).update(equip);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao atualizar." }; }
    },
    deleteEquipamento: async function(id_doc) {
        await db.collection('equipamentos').doc(id_doc).delete();
        return { success: true };
    },
    // --- MÓDULO CLIENTES ---
    getClientes: async function() {
        try {
            const snapshot = await db.collection('clientes').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    getClienteById: async function(id) {
        try {
            const doc = await db.collection('clientes').doc(id).get();
            return doc.exists ? { id_doc: doc.id, ...doc.data() } : null;
        } catch (e) { return null; }
    },
    saveCliente: async function(cliente) {
        // Verifica se já existe o mesmo CNPJ E o mesmo Apelido de Local
        const check = await db.collection('clientes')
            .where('documento', '==', cliente.documento)
            .where('apelido', '==', cliente.apelido)
            .get();
            
        if (!check.empty) return { success: false, msg: "Este Ponto de Entrega já está cadastrado para este CNPJ." };
        
        await db.collection('clientes').add(cliente);
        this.logAction("CADASTRO", `Novo Ponto de Entrega: ${cliente.apelido} (${cliente.razao})`);
        return { success: true };
    },
    updateCliente: async function(id, cliente) {
        try {
            await db.collection('clientes').doc(id).update(cliente);
            this.logAction("EDIÇÃO", `Cliente atualizado: ${cliente.razao}`);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao atualizar cliente." }; }
    },
    deleteCliente: async function(id_doc) {
        await db.collection('clientes').doc(id_doc).delete();
        return { success: true };
    },
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

    // Atualiza o Status Logístico do Agendamento (Monitor)
    updateAppointmentStatus: async function(id_doc, newStatus, obs) {
        try {
            await db.collection('agendamentos').doc(id_doc).update({
                status: newStatus,
                statusObs: obs,
                motivoOcorrencia: motivoOcorrencia,
                statusUpdatedAt: new Date().toISOString()
            });
            this.logAction("MONITOR", `Status alterado p/ ${newStatus} (Agendamento ID: ${id_doc})`);
            return { success: true };
        } catch(e) { 
            return { success: false, msg: "Erro ao atualizar status logístico." }; 
        }
    },
    // Atualiza o Status de Vários Slots Agrupados de uma vez
    updateStatusBatch: async function(id_docs, newStatus, obs, motivoOcorrencia = "") {
        try {
            const batch = db.batch();
            id_docs.forEach(id => {
                const ref = db.collection('agendamentos').doc(id);
                batch.update(ref, {
                    status: newStatus,
                    statusObs: obs,
                    motivoOcorrencia: motivoOcorrencia,
                    statusUpdatedAt: new Date().toISOString(),
                    statusUpdatedBy: CURRENT_USER.name // <- NOVA LINHA: Regista quem fez o apontamento
                });
            });
            await batch.commit();
            this.logAction("MONITOR", `Status em lote alterado p/ ${newStatus} (${id_docs.length} slots)`);
            return { success: true };
        } catch(e) {
            console.error(e);
            return { success: false, msg: "Erro ao atualizar status em lote." };
        }
    },
    saveTratativa: async function(idsString, planoAcao) {
        try {
            const batch = db.batch();
            const id_docs = idsString.split(',');
            id_docs.forEach(id => {
                const ref = db.collection('agendamentos').doc(id);
                batch.update(ref, {
                    anomaliaTratada: true,
                    planoAcao: planoAcao,
                    status: 'RESOLVIDO' 
                });
            });
            await batch.commit();
            this.logAction("OCORRÊNCIA", `Tratativa salva p/ lote (${id_docs.length} slots)`);
            return { success: true };
        } catch(e) {
            return { success: false, msg: "Erro ao salvar tratativa." };
        }
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

    // --- MÓDULO MOTORISTAS ---
    getMotoristas: async function() {
        try {
            const snapshot = await db.collection('motoristas').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    getMotoristaById: async function(id) {
        try {
            const doc = await db.collection('motoristas').doc(id).get();
            return doc.exists ? { id_doc: doc.id, ...doc.data() } : null;
        } catch (e) { return null; }
    },
    saveMotorista: async function(motorista) {
        const check = await db.collection('motoristas').where('cpf', '==', motorista.cpf).get();
        if (!check.empty) return { success: false, msg: "CPF já cadastrado na base." };
        await db.collection('motoristas').add(motorista);
        this.logAction("CADASTRO", `Novo Motorista: ${motorista.nome}`);
        return { success: true };
    },
    updateMotorista: async function(id, motorista) {
        try {
            await db.collection('motoristas').doc(id).update(motorista);
            this.logAction("EDIÇÃO", `Motorista atualizado: ${motorista.nome}`);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao atualizar motorista." }; }
    },
    deleteMotorista: async function(id_doc) {
        await db.collection('motoristas').doc(id_doc).delete();
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
// Abre e fecha o menu lateral no celular
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('active');
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
    else if (page === 'Equipamento') { renderEquipamento(workspace); }
    else if (page === 'Cliente') { renderCliente(workspace); }
    else if (page === 'Motorista') { renderMotorista(workspace); }
    else if (page === 'Agendamentos') { renderAgendamentos(workspace); }
    else if (page === 'Monitor') { renderMonitor(workspace); }
    else if (page === 'Ocorrências') { renderOcorrencias(workspace); }
    else if (page === 'Logs do Sistema') { renderLogsPage(workspace); }
    else if (page === 'Perfis e Permissões') { renderUsersPage(workspace); }
    else { workspace.innerHTML = `<div class="card"><h3>${page}</h3><p>Em desenvolvimento.</p></div>`; }
    if (window.innerWidth <= 768) {
        document.getElementById('sidebar').classList.remove('active');
    }
}

/* --- MÓDULO TRANSPORTADORA (COMPLETO) --- */
async function renderTransportadora(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Apenas Gestores e Master podem cadastrar transportadoras.</p></div>`;
        return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando banco de transportadoras...</div>';
    
    // Busca a lista no Firebase
    const transps = await StorageManager.getTransportadoras();
    
    // Geração da Tabela com Ícones Corrigidos
    let rows = transps.map(t => `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">${t.cnpj}</td>
            <td><strong>${t.razao}</strong><br><span style="font-size:0.7rem; color:#888;">${t.fantasia || ''}</span></td>
            <td>${t.contatoNome}<br><span style="font-size:0.7rem;">${t.contatoTel}</span></td>
            <td>${t.rntrcValidade}<br><span style="font-size:0.7rem; color:${new Date(t.rntrcValidade) < new Date() ? '#FF3131' : '#00D4FF'}">RNTRC</span></td>
            <td style="font-size:0.7rem;">RCTR-C: ${t.seguros?.rctrc?.seguradora || '-'}<br>Frota: ${t.frotaPropriaPct || '0'}%</td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px 10px; margin-right:5px;" onclick="handleEditTransportadora('${t.id_doc}')" title="Editar"><i class="fa-solid fa-pencil"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 10px;" onclick="handleDeleteTransportadora('${t.id_doc}')" title="Apagar"><i class="fa-solid fa-trash"></i></button>
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
                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead><tr><th>CNPJ</th><th>Razão / Fantasia</th><th>Contato</th><th>RNTRC</th><th>Detalhes</th><th>Ações</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
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
            if (!status.innerText.includes("EDIÇÃO") && !status.innerText.includes("NOVO")) {
                status.innerText = "DOCUMENTAÇÃO OK"; 
            }
            status.className = "status-neon active"; 
        }
    }
}

async function handleSaveTransportadora() {
    const idDoc = document.getElementById('t-id-doc').value;
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
        if (!confirm(`Confirma a atualização dos dados de ${razao}?`)) return;
        const res = await StorageManager.updateTransportadora(idDoc, dataPayload);
        if (res.success) {
            notify("Atualizado com sucesso!");
            renderTransportadora(document.getElementById('workspace'));
        } else {
            notify(res.msg, "error");
        }
    } else {
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

/* --- MÓDULO EQUIPAMENTO --- */
async function renderEquipamento(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Sem permissão.</p></div>`;
        return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando frota...</div>';
    
    // Busca apenas a frota
    const equips = await StorageManager.getEquipamentos();
    
    let rows = equips.map(e => `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">
                <span style="color:var(--eletra-aqua); font-weight:bold; font-size:0.85rem;">${e.placa}</span>
                ${e.placasReboque ? '<br><span style="font-size:0.7rem; color:#aaa;">Reb: '+e.placasReboque+'</span>' : ''}
            </td>
            <td>${e.tipo}<br><span style="font-size:0.7rem;">${e.carroceria || ''} | ${e.modelo || ''}</span></td>
            <td>${e.capacidade} kg<br><span style="font-size:0.7rem; color:#aaa;">PBT: ${e.pbt} - Tara: ${e.tara}</span><br><span style="font-size:0.7rem; color:#00D4FF;">Vol: ${e.cubagem || 0} m³</span></td>
            <td>
                <span style="font-size:0.75rem;">${e.proprietario || '-'}</span><br>
                <span style="font-size:0.65rem; color:#888;">Doc: ${e.docProprietario || ''}</span><br>
                <span style="font-size:0.65rem; color:#FF8200;">RNTRC: ${e.rntrcProp || '-'}</span>
            </td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px 10px; margin-right:5px;" onclick="handleEditEquipamento('${e.id_doc}')" title="Editar"><i class="fa-solid fa-pencil"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 10px;" onclick="handleDeleteEquipamento('${e.id_doc}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    if (equips.length === 0) rows = `<tr><td colspan="5" style="text-align:center; padding:15px; font-style:italic;">Nenhum veículo cadastrado.</td></tr>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" id="tab-eq-geral" onclick="switchTab('eq-geral')">Cadastro CRLV</button>
                <button class="tab-btn" onclick="switchTab('eq-lista')" style="color:var(--eletra-orange)">Frota Cadastrada (${equips.length})</button>
            </div>
            
            <div id="eq-geral" class="tab-content active" style="position:relative;">
                <div id="eq-status-card" class="status-neon active">NOVO VEÍCULO</div>
                <input type="hidden" id="e-id-doc">

                <fieldset class="prop-group">
                    <legend>DADOS DO VEÍCULO (CONJUNTO)</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label style="color:var(--eletra-aqua)">Placa Cavalo / Veículo (Mercosul)*</label>
                            <input type="text" id="e-placa" placeholder="ABC1D23 ou ABC1234" oninput="this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '')" style="font-weight:bold; letter-spacing: 1px;">
                        </div>
                        <div class="form-row-col">
                            <label>Placas Reboques (Obrigatório p/ Carreta)</label>
                            <input type="text" id="e-placas-reboque" placeholder="ABC1D23 / XYZ9999" oninput="this.value = this.value.toUpperCase()">
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top:10px;">
                         <div class="form-row-col">
                            <label>Tipo de Veículo*</label>
                            <select id="e-tipo" onchange="checkReboqueRequirement()">
                                <option value="">Selecione a categoria...</option>
                                <option value="Moto">Moto</option>
                                <option value="Passeio">Passeio</option>
                                <option value="Caminhonete">Caminhonete (Strada, Fiorino)</option>
                                <option value="Pick Up">Pick Up (Hilux, S10)</option>
                                <option value="Utilitário">Utilitário (Hyundai HR, Iveco)</option>
                                <option value="VUC">VUC (VW Express)</option>
                                <option value="3/4">3/4 (VW 9.170, Accelo)</option>
                                <option value="Toco">Toco (Semipesado 4x2)</option>
                                <option value="Truck">Truck (Pesado 6x2 - 3 Eixos)</option>
                                <option value="Bitruck">Bitruck (Pesado 8x2 - 4 Eixos)</option>
                                <option value="Carreta">Carreta (5 eixos ou mais)</option>
                            </select>
                        </div>
                        <div class="form-row-col">
                            <label>Tipo de Carroceria*</label>
                            <select id="e-carroceria">
                                <option value="">Selecione...</option>
                                <option value="Baú">Baú</option>
                                <option value="Sider">Sider</option>
                                <option value="Grade Baixa">Grade Baixa (Carga Seca)</option>
                                <option value="Prancha">Prancha</option>
                                <option value="Refrigerado">Refrigerado</option>
                                <option value="Não se aplica">Não se aplica</option>
                            </select>
                        </div>
                    </div>
                    
                     <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; margin-top:10px;">
                         <div class="form-row-col"><label>Marca</label><input type="text" id="e-marca" placeholder="Ex: Scania"></div>
                         <div class="form-row-col"><label>Modelo</label><input type="text" id="e-modelo" placeholder="Ex: R450"></div>
                         <div class="form-row-col"><label>Ano Fab.</label><input type="number" id="e-ano-fab" placeholder="2020"></div>
                         <div class="form-row-col"><label>Ano Mod.</label><input type="number" id="e-ano-mod" placeholder="2021"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>PROPRIETÁRIO & DOCUMENTAÇÃO (CRLV)</legend>
                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px;">
                        <div class="form-row-col"><label>Nome do Proprietário*</label><input type="text" id="e-proprietario" placeholder="Nome exato do documento"></div>
                        <div class="form-row-col"><label>CPF ou CNPJ*</label><input type="text" id="e-doc-prop" placeholder="Somente números"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label style="color:var(--eletra-orange)">RENAVAM*</label><input type="text" id="e-renavam" placeholder="Número do Renavam"></div>
                        <div class="form-row-col"><label>RNTRC do Proprietário</label><input type="text" id="e-rntrc-prop" placeholder="Registro ANTT"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>CAPACIDADE DE CARGA</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px;">
                        <div class="form-row-col"><label>PBT (kg)</label><input type="number" id="e-pbt" placeholder="Ex: 45000" oninput="calcCapacidade()"></div>
                        <div class="form-row-col"><label>Tara (kg)</label><input type="number" id="e-tara" placeholder="Ex: 15000" oninput="calcCapacidade()"></div>
                        <div class="form-row-col"><label style="color:var(--eletra-orange)">Lotação (kg)</label><input type="number" id="e-cap" readonly style="background:#222; font-weight:bold; color:var(--eletra-orange);"></div>
                        <div class="form-row-col"><label>Cubagem (m³)</label><input type="number" id="e-cubagem" placeholder="Ex: 110"></div>
                    </div>
                </fieldset>

                <div class="props-footer" style="margin-top: 20px;">
                    <button id="btn-save-eq" class="mark-btn action apply" onclick="handleSaveEquipamento()">SALVAR CADASTRO</button>
                    <button class="mark-btn action" onclick="renderEquipamento(document.getElementById('workspace'))">CANCELAR</button>
                </div>
            </div>

            <div id="eq-lista" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>Placas</th><th>Veículo</th><th>Capacidade</th><th>Proprietário CRLV</th><th>Ações</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

/* --- MÓDULO CLIENTE (CRUD COMPLETO) --- */
async function renderCliente(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Sem permissão.</p></div>`;
        return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando clientes...</div>';
    
    const clientes = await StorageManager.getClientes();
    
    let rows = clientes.map(c => `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">${c.documento}</td>
            <td>
                <strong>${c.razao}</strong><br>
                <span style="font-size:0.75rem; color:var(--eletra-orange); font-weight:bold;">📍 ${c.apelido || 'Matriz'}</span>
            </td>
            <td>${c.cidade || '-'} / ${c.uf || '-'}</td>
            <td><span style="font-size:0.75rem;">${c.contatoNome || '-'}<br>${c.contatoTel || '-'}</span></td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px 10px; margin-right:5px;" onclick="handleEditCliente('${c.id_doc}')" title="Editar"><i class="fa-solid fa-pencil"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 10px;" onclick="handleDeleteCliente('${c.id_doc}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    if (clientes.length === 0) rows = `<tr><td colspan="5" style="text-align:center; padding:15px; font-style:italic;">Nenhum cliente cadastrado.</td></tr>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" id="tab-cli-geral" onclick="switchTab('cli-geral')">Ficha do Cliente</button>
                <button class="tab-btn" onclick="switchTab('cli-lista')" style="color:var(--eletra-orange)">Base Cadastrada (${clientes.length})</button>
            </div>
            
            <div id="cli-geral" class="tab-content active" style="position:relative;">
                <div id="cli-status-card" class="status-neon active">NOVO CADASTRO</div>
                <input type="hidden" id="c-id-doc">

                <fieldset class="prop-group">
                    <legend>DADOS FISCAIS</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>CNPJ / CPF*</label>
                            <input type="text" id="c-doc" placeholder="Apenas números">
                        </div>
                        <div class="form-row-col">
                            <label>Inscrição Estadual (IE)</label>
                            <input type="text" id="c-ie" placeholder="Ou ISENTO">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>Razão Social / Nome*</label><input type="text" id="c-razao"></div>
                        <div class="form-row-col"><label>Nome Fantasia</label><input type="text" id="c-fantasia"></div>
                        <div class="form-row-col"><label style="color:var(--eletra-orange)">Apelido do Local*</label><input type="text" id="c-apelido" placeholder="Ex: CD Sul, Loja Centro"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>ENDEREÇO DE ENTREGA</legend>
                    <div style="display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>CEP <i class="fa-solid fa-magnifying-glass" style="color:var(--eletra-aqua); cursor:pointer;" onclick="buscaCepCliente()"></i></label>
                            <input type="text" id="c-cep" placeholder="00000-000" onblur="buscaCepCliente()">
                        </div>
                        <div class="form-row-col"><label>Logradouro (Rua/Av)*</label><input type="text" id="c-rua"></div>
                        <div class="form-row-col"><label>Número*</label><input type="text" id="c-num"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; margin-top:10px;">
                         <div class="form-row-col" style="grid-column: span 2;"><label>Complemento</label><input type="text" id="c-comp" placeholder="Galpão, Sala..."></div>
                         <div class="form-row-col"><label>Bairro*</label><input type="text" id="c-bairro"></div>
                         <div class="form-row-col"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>Cidade*</label><input type="text" id="c-cidade"></div>
                        <div class="form-row-col"><label>UF*</label><input type="text" id="c-uf" maxlength="2" placeholder="Ex: SP" oninput="this.value = this.value.toUpperCase()"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>CONTATO OPERACIONAL</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                        <div class="form-row-col"><label>Nome Contato</label><input type="text" id="c-contato-nome" placeholder="Responsável Recebimento"></div>
                        <div class="form-row-col"><label>Telefone / Whats</label><input type="text" id="c-contato-tel" placeholder="(11) 90000-0000"></div>
                        <div class="form-row-col"><label>E-mail</label><input type="email" id="c-contato-email" placeholder="email@cliente.com"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>REGRAS DE RECEBIMENTO & AGENDAMENTO (MATRIZ LOGÍSTICA)</legend>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                        <div class="form-row-col">
                            <label>Horário de Func.</label>
                            <input type="text" id="c-horario" placeholder="Ex: 08:00 às 16:00">
                        </div>
                        <div class="form-row-col">
                            <label>Método de Agend.</label>
                            <select id="c-metodo-agendamento">
                                <option value="">Selecione...</option>
                                <option value="E-MAIL">E-mail</option>
                                <option value="PORTAL">Portal B2B</option>
                                <option value="TELEFONE">Telefone</option>
                                <option value="ORDEM DE CHEGADA">Ordem de Chegada</option>
                            </select>
                        </div>
                        <div class="form-row-col">
                            <label>Permite Sobreposição?</label>
                            <select id="c-sobreposicao">
                                <option value="SIM">SIM</option>
                                <option value="NÃO">NÃO</option>
                            </select>
                        </div>
                        <div class="form-row-col">
                            <label>Dimensões Max (CxLxA)</label>
                            <input type="text" id="c-dimensoes" placeholder="Ex: 1000X1200X970">
                        </div>
                    </div>

                    <div class="form-row-col">
                        <label style="color:var(--eletra-orange)">Tipos de Veículos Aceitos (Clique para selecionar)</label>
                        <div class="marking-group">
                            <button class="mark-btn veic-btn" onclick="this.classList.toggle('selected')">CARRETA BAÚ</button>
                            <button class="mark-btn veic-btn" onclick="this.classList.toggle('selected')">CARRETA SIDER</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">TRUCK</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">TOCO</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">VUC / 3/4</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">UTILITÁRIO</button>
                        </div>
                    </div>

                    <div class="form-row-col" style="margin-top:10px;">
                        <label>Observações / Exceções de Entrega</label>
                        <input type="text" id="c-obs-logistica" placeholder="Ex: Sobreposição permitida com altura máxima de 1,4 metros...">
                    </div>
                </fieldset>

                <div class="props-footer" style="margin-top: 20px;">
                    <button id="btn-save-cli" class="mark-btn action apply" onclick="handleSaveCliente()">SALVAR CLIENTE</button>
                    <button class="mark-btn action" onclick="renderCliente(document.getElementById('workspace'))">CANCELAR</button>
                </div>
            </div>

            <div id="cli-lista" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>CNPJ/CPF</th><th>Cliente</th><th>Localidade</th><th>Contato</th><th>Ações</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

// Consumo de API Externa (ViaCEP) para facilitar cadastro
async function buscaCepCliente() {
    let cep = document.getElementById('c-cep').value.replace(/\D/g, '');
    if (cep.length === 8) {
        try {
            let response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
            let data = await response.json();
            if (!data.erro) {
                document.getElementById('c-rua').value = data.logradouro;
                document.getElementById('c-bairro').value = data.bairro;
                document.getElementById('c-cidade').value = data.localidade;
                document.getElementById('c-uf').value = data.uf;
                document.getElementById('c-num').focus();
            } else {
                notify("CEP não encontrado.", "error");
            }
        } catch(e) {
            console.error(e);
        }
    }
}

async function handleSaveCliente() {
    const idDoc = document.getElementById('c-id-doc').value;
    const documento = document.getElementById('c-doc').value.replace(/\D/g, '');
    const razao = document.getElementById('c-razao').value.trim();
    const apelido = document.getElementById('c-apelido').value.trim();
    if (!documento || !razao || !apelido) { notify("CNPJ, Razão Social e Apelido do Local são obrigatórios.", "error"); return; }

    // Coleta todos os botões de veículos que estão marcados
    const veiculosAceitos = Array.from(document.querySelectorAll('.veic-btn.selected')).map(btn => btn.innerText);

    const payload = {
        documento: documento,
        ie: document.getElementById('c-ie').value.trim(),
        razao: razao,
        apelido: apelido,
        fantasia: document.getElementById('c-fantasia').value.trim(),
        cep: document.getElementById('c-cep').value.trim(),
        rua: document.getElementById('c-rua').value.trim(),
        numero: document.getElementById('c-num').value.trim(),
        complemento: document.getElementById('c-comp').value.trim(),
        bairro: document.getElementById('c-bairro').value.trim(),
        cidade: document.getElementById('c-cidade').value.trim(),
        uf: document.getElementById('c-uf').value.toUpperCase(),
        contatoNome: document.getElementById('c-contato-nome').value.trim(),
        contatoTel: document.getElementById('c-contato-tel').value.trim(),
        contatoEmail: document.getElementById('c-contato-email').value.trim(),
        // NOVOS DADOS DA MATRIZ
        horarioRecebimento: document.getElementById('c-horario').value.trim(),
        metodoAgendamento: document.getElementById('c-metodo-agendamento').value,
        sobreposicao: document.getElementById('c-sobreposicao').value,
        dimensoes: document.getElementById('c-dimensoes').value.trim(),
        veiculosPermitidos: veiculosAceitos,
        obsLogistica: document.getElementById('c-obs-logistica').value.trim(),
        user: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    if (idDoc) {
        if (!confirm(`Atualizar cadastro de ${razao}?`)) return;
        const res = await StorageManager.updateCliente(idDoc, payload);
        if (res.success) { notify("Cliente atualizado!"); renderCliente(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    } else {
        if (!confirm(`Cadastrar o cliente ${razao}?`)) return;
        const res = await StorageManager.saveCliente(payload);
        if (res.success) { notify("Cliente cadastrado!"); renderCliente(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    }
}

async function handleEditCliente(id) {
    const c = await StorageManager.getClienteById(id);
    if (!c) return;
    document.getElementById('c-id-doc').value = c.id_doc;
    document.getElementById('c-doc').value = c.documento;
    document.getElementById('c-ie').value = c.ie || '';
    document.getElementById('c-razao').value = c.razao;
    document.getElementById('c-fantasia').value = c.fantasia || '';
    document.getElementById('c-apelido').value = c.apelido || '';
    document.getElementById('c-cep').value = c.cep || '';
    document.getElementById('c-rua').value = c.rua || '';
    document.getElementById('c-num').value = c.numero || '';
    document.getElementById('c-comp').value = c.complemento || '';
    document.getElementById('c-bairro').value = c.bairro || '';
    document.getElementById('c-cidade').value = c.cidade || '';
    document.getElementById('c-uf').value = c.uf || '';
    document.getElementById('c-contato-nome').value = c.contatoNome || '';
    document.getElementById('c-contato-tel').value = c.contatoTel || '';
    document.getElementById('c-contato-email').value = c.contatoEmail || '';
    // CARREGA NOVOS DADOS DA MATRIZ
    document.getElementById('c-horario').value = c.horarioRecebimento || '';
    document.getElementById('c-metodo-agendamento').value = c.metodoAgendamento || '';
    document.getElementById('c-sobreposicao').value = c.sobreposicao || 'SIM';
    document.getElementById('c-dimensoes').value = c.dimensoes || '';
    document.getElementById('c-obs-logistica').value = c.obsLogistica || '';
    // REACENDE OS BOTÕES DE VEÍCULOS
    document.querySelectorAll('.veic-btn').forEach(btn => {
        if (c.veiculosPermitidos && c.veiculosPermitidos.includes(btn.innerText)) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    document.getElementById('cli-status-card').innerText = "EM EDIÇÃO";
    document.getElementById('cli-status-card').className = "status-neon active";
    document.getElementById('btn-save-cli').innerText = "ATUALIZAR DADOS";
    
    // Força a aba
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('cli-geral').classList.add('active');
    document.getElementById('tab-cli-geral').classList.add('active');

    notify(`Editando ${c.razao}`, "info");
}

async function handleDeleteCliente(id) {
    if(!confirm("Tem certeza que deseja apagar este cliente?")) return;
    await StorageManager.deleteCliente(id);
    notify("Cliente apagado com sucesso.");
    renderCliente(document.getElementById('workspace'));
}

// Lógica de Cálculo de Capacidade
function calcCapacidade() {
    const pbt = parseFloat(document.getElementById('e-pbt').value) || 0;
    const tara = parseFloat(document.getElementById('e-tara').value) || 0;
    const liq = pbt - tara;
    document.getElementById('e-cap').value = liq > 0 ? liq : 0;
}

// Validação visual de carreta
function checkReboqueRequirement() {
    const tipo = document.getElementById('e-tipo').value;
    const lblReb = document.querySelector('label[for="e-placas-reboque"]'); 
    const inputReb = document.getElementById('e-placas-reboque');
    
    if (tipo === 'Carreta') {
        if(lblReb) lblReb.style.color = '#FF8200';
        inputReb.placeholder = "OBRIGATÓRIO: Placa1 / Placa2";
    } else {
        if(lblReb) lblReb.style.color = '#aaa';
        inputReb.placeholder = "Opcional";
    }
    suggestTara(); 
}
//Sugerir Tara de veículos
function suggestTara() {
    const tipo = document.getElementById('e-tipo').value;
    const fieldTara = document.getElementById('e-tara');
    if(fieldTara.value) return;
    const taras = {
        'Pick Up': 1100,
        'Utilitário':2000,
        'VUC': 2000,
        '3/4': 4000,
        'Toco': 6000,
        'Truck': 8500,
        'Bitruck': 10500,
        'Carreta': 16000
    };
    if(taras[tipo]) {
        fieldTara.value = taras[tipo];
        calcCapacidade();
    }
}
//Salvar equipamento
async function handleSaveEquipamento() {
    const idDoc = document.getElementById('e-id-doc').value;
    const placa = document.getElementById('e-placa').value.trim();
    const tipo = document.getElementById('e-tipo').value;
    const carroceria = document.getElementById('e-carroceria').value;
    const placasReb = document.getElementById('e-placas-reboque').value.trim();
    const prop = document.getElementById('e-proprietario').value.trim();
    const docProp = document.getElementById('e-doc-prop').value.trim();

    if (!placa || !tipo || !prop || !docProp || !document.getElementById('e-renavam').value.trim()) { 
        notify("Placa, Tipo, Proprietário, Doc e Renavam são obrigatórios.", "error"); 
        return; 
    }

    // Validação Específica para Carreta
    if (tipo === 'Carreta' && !placasReb) {
        notify("Para CARRETA, é obrigatório informar as placas dos reboques.", "error");
        document.getElementById('e-placas-reboque').focus();
        return;
    }

    const payload = {
        placa: placa,
        placasReboque: placasReb,
        tipo: tipo,
        carroceria: carroceria, 
        marca: document.getElementById('e-marca').value.trim(),
        modelo: document.getElementById('e-modelo').value.trim(),
        anoFab: document.getElementById('e-ano-fab').value.trim(),
        anoMod: document.getElementById('e-ano-mod').value.trim(),
        proprietario: prop,
        docProprietario: docProp,
        renavam: document.getElementById('e-renavam').value.trim(), 
        rntrcProp: document.getElementById('e-rntrc-prop').value.trim(), 
        pbt: document.getElementById('e-pbt').value.trim(),
        tara: document.getElementById('e-tara').value.trim(),
        capacidade: document.getElementById('e-cap').value.trim(),
        cubagem: document.getElementById('e-cubagem').value.trim(), 
        user: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    if (idDoc) {
        if (!confirm(`Atualizar cadastro do veículo ${placa}?`)) return;
        const res = await StorageManager.updateEquipamento(idDoc, payload);
        if (res.success) { notify("Cadastro atualizado!"); renderEquipamento(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    } else {
        if (!confirm(`Confirmar cadastro do veículo ${placa}?`)) return;
        const res = await StorageManager.saveEquipamento(payload);
        if (res.success) { notify("Veículo cadastrado!"); renderEquipamento(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    }
}
// Editar equipamento CRUD
async function handleEditEquipamento(id) {
    const e = await StorageManager.getEquipamentoById(id);
    if (!e) return;

    document.getElementById('e-id-doc').value = e.id_doc;
    document.getElementById('e-placa').value = e.placa;
    document.getElementById('e-placas-reboque').value = e.placasReboque || '';
    document.getElementById('e-tipo').value = e.tipo;
    document.getElementById('e-carroceria').value = e.carroceria || '';
    document.getElementById('e-marca').value = e.marca || '';
    document.getElementById('e-modelo').value = e.modelo || '';
    document.getElementById('e-ano-fab').value = e.anoFab || '';
    document.getElementById('e-ano-mod').value = e.anoMod || '';
    document.getElementById('e-proprietario').value = e.proprietario || '';
    document.getElementById('e-doc-prop').value = e.docProprietario || '';
    document.getElementById('e-renavam').value = e.renavam || '';
    document.getElementById('e-rntrc-prop').value = e.rntrcProp || '';
    document.getElementById('e-pbt').value = e.pbt || '';
    document.getElementById('e-tara').value = e.tara || '';
    document.getElementById('e-cap').value = e.capacidade || '';
    document.getElementById('e-cubagem').value = e.cubagem || '';
    document.getElementById('eq-status-card').innerText = "EM EDIÇÃO";
    document.getElementById('eq-status-card').className = "status-neon active";
    document.getElementById('btn-save-eq').innerText = "ATUALIZAR DADOS";
    // Força a troca de aba
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('eq-geral').classList.add('active');
    document.getElementById('tab-eq-geral').classList.add('active');
    checkReboqueRequirement(); // Ajusta os placeholders
    notify("Editando veículo " + e.placa, "info");
}
//CRUD Deletar equipamento
async function handleDeleteEquipamento(id) {
    if(!confirm("Remover este veículo da base?")) return;
    await StorageManager.deleteEquipamento(id);
    notify("Cadastro removido.");
    renderEquipamento(document.getElementById('workspace'));
}

async function handleEditTransportadora(id) {
    const t = await StorageManager.getTransportadoraById(id);
    if (!t) { notify("Erro ao carregar dados.", "error"); return; }
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

    document.querySelectorAll('.zone-btn').forEach(btn => {
        if (t.zonas && t.zonas.includes(btn.innerText)) btn.classList.add('selected');
        else btn.classList.remove('selected');
    });

    document.getElementById('status-card').innerText = "EM EDIÇÃO";
    document.getElementById('status-card').className = "status-neon active";
    document.getElementById('btn-save-transp').innerText = "ATUALIZAR DADOS";
    document.getElementById('btn-save-transp').style.color = "var(--eletra-orange)";
    document.getElementById('btn-save-transp').style.borderColor = "var(--eletra-orange)";
    
    switchTab('geral');
    validateTranspDates();
    notify("Modo de edição ativado.", "info");
}

function cancelEditMode() {
    renderTransportadora(document.getElementById('workspace'));
}

async function handleDeleteTransportadora(id_doc) {
    if (!confirm("Deseja realmente excluir esta transportadora?")) return;
    const res = await StorageManager.deleteTransportadora(id_doc);
    if (res.success) {
        notify("Transportadora excluída.");
        renderTransportadora(document.getElementById('workspace'));
    }
}

/* --- MÓDULO CLIENTE (CRUD COMPLETO E MATRIZ LOGÍSTICA) --- */
async function renderCliente(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Sem permissão.</p></div>`;
        return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando clientes...</div>';
    
    const clientes = await StorageManager.getClientes();
    
    let rows = clientes.map(c => `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">${c.documento}</td>
            <td>
                <strong>${c.razao}</strong><br>
                <span style="font-size:0.75rem; color:var(--eletra-orange); font-weight:bold;">📍 ${c.apelido || 'Matriz'}</span>
            </td>
            <td>${c.cidade || '-'} / ${c.uf || '-'}</td>
            <td><span style="font-size:0.75rem;">${c.contatoNome || '-'}<br>${c.contatoTel || '-'}</span></td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px 10px; margin-right:5px;" onclick="handleEditCliente('${c.id_doc}')" title="Editar"><i class="fa-solid fa-pencil"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 10px;" onclick="handleDeleteCliente('${c.id_doc}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    if (clientes.length === 0) rows = `<tr><td colspan="5" style="text-align:center; padding:15px; font-style:italic;">Nenhum cliente cadastrado.</td></tr>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" id="tab-cli-geral" onclick="switchTab('cli-geral')">Ficha do Cliente</button>
                <button class="tab-btn" onclick="switchTab('cli-lista')" style="color:var(--eletra-orange)">Base Cadastrada (${clientes.length})</button>
            </div>
            
            <div id="cli-geral" class="tab-content active" style="position:relative;">
                <div id="cli-status-card" class="status-neon active">NOVO CADASTRO</div>
                <input type="hidden" id="c-id-doc">

                <fieldset class="prop-group">
                    <legend>DADOS FISCAIS</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>CNPJ / CPF*</label>
                            <input type="text" id="c-doc" placeholder="Apenas números">
                        </div>
                        <div class="form-row-col">
                            <label>Inscrição Estadual (IE)</label>
                            <input type="text" id="c-ie" placeholder="Ou ISENTO">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>Razão Social / Nome*</label><input type="text" id="c-razao"></div>
                        <div class="form-row-col"><label>Nome Fantasia</label><input type="text" id="c-fantasia"></div>
                        <div class="form-row-col"><label style="color:var(--eletra-orange)">Apelido do Local*</label><input type="text" id="c-apelido" placeholder="Ex: CD Sul, Loja Centro"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>ENDEREÇO DE ENTREGA</legend>
                    <div style="display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>CEP <i class="fa-solid fa-magnifying-glass" style="color:var(--eletra-aqua); cursor:pointer;" onclick="buscaCepCliente()"></i></label>
                            <input type="text" id="c-cep" placeholder="00000-000" onblur="buscaCepCliente()">
                        </div>
                        <div class="form-row-col"><label>Logradouro (Rua/Av)*</label><input type="text" id="c-rua"></div>
                        <div class="form-row-col"><label>Número*</label><input type="text" id="c-num"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; margin-top:10px;">
                         <div class="form-row-col" style="grid-column: span 2;"><label>Complemento</label><input type="text" id="c-comp" placeholder="Galpão, Sala..."></div>
                         <div class="form-row-col"><label>Bairro*</label><input type="text" id="c-bairro"></div>
                         <div class="form-row-col"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>Cidade*</label><input type="text" id="c-cidade"></div>
                        <div class="form-row-col"><label>UF*</label><input type="text" id="c-uf" maxlength="2" placeholder="Ex: SP" oninput="this.value = this.value.toUpperCase()"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>CONTATO OPERACIONAL</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                        <div class="form-row-col"><label>Nome Contato</label><input type="text" id="c-contato-nome" placeholder="Responsável Recebimento"></div>
                        <div class="form-row-col"><label>Telefone / Whats</label><input type="text" id="c-contato-tel" placeholder="(11) 90000-0000"></div>
                        <div class="form-row-col"><label>E-mail</label><input type="email" id="c-contato-email" placeholder="email@cliente.com"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>REGRAS DE RECEBIMENTO & AGENDAMENTO (MATRIZ LOGÍSTICA)</legend>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                        <div class="form-row-col">
                            <label>Horário de Func.</label>
                            <input type="text" id="c-horario" placeholder="Ex: 08:00 às 16:00">
                        </div>
                        <div class="form-row-col">
                            <label>Método de Agend.</label>
                            <select id="c-metodo-agendamento">
                                <option value="">Selecione...</option>
                                <option value="E-MAIL">E-mail</option>
                                <option value="PORTAL">Portal B2B</option>
                                <option value="TELEFONE">Telefone</option>
                                <option value="ORDEM DE CHEGADA">Ordem de Chegada</option>
                            </select>
                        </div>
                        <div class="form-row-col">
                            <label>Permite Sobreposição?</label>
                            <select id="c-sobreposicao">
                                <option value="SIM">SIM</option>
                                <option value="NÃO">NÃO</option>
                            </select>
                        </div>
                        <div class="form-row-col">
                            <label>Dimensões Max (CxLxA)</label>
                            <input type="text" id="c-dimensoes" placeholder="Ex: 1000X1200X970">
                        </div>
                    </div>

                    <div class="form-row-col">
                        <label style="color:var(--eletra-orange)">Tipos de Veículos Aceitos (Clique para selecionar)</label>
                        <div class="marking-group">
                            <button class="mark-btn veic-btn" onclick="this.classList.toggle('selected')">CARRETA BAÚ</button>
                            <button class="mark-btn veic-btn" onclick="this.classList.toggle('selected')">CARRETA SIDER</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">TRUCK</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">TOCO</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">VUC / 3/4</button>
                            <button class="mark-btn veic-btn selected" onclick="this.classList.toggle('selected')">UTILITÁRIO</button>
                        </div>
                    </div>

                    <div class="form-row-col" style="margin-top:10px;">
                        <label>Observações / Exceções de Entrega</label>
                        <input type="text" id="c-obs-logistica" placeholder="Ex: Sobreposição permitida com altura máxima de 1,4 metros...">
                    </div>
                </fieldset>

                <div class="props-footer" style="margin-top: 20px;">
                    <button id="btn-save-cli" class="mark-btn action apply" onclick="handleSaveCliente()">SALVAR CLIENTE</button>
                    <button class="mark-btn action" onclick="renderCliente(document.getElementById('workspace'))">CANCELAR</button>
                </div>
            </div>

            <div id="cli-lista" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>CNPJ/CPF</th><th>Cliente</th><th>Localidade</th><th>Contato</th><th>Ações</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

// Consumo de API Externa (ViaCEP) para facilitar cadastro
async function buscaCepCliente() {
    let cep = document.getElementById('c-cep').value.replace(/\D/g, '');
    if (cep.length === 8) {
        try {
            let response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
            let data = await response.json();
            if (!data.erro) {
                document.getElementById('c-rua').value = data.logradouro;
                document.getElementById('c-bairro').value = data.bairro;
                document.getElementById('c-cidade').value = data.localidade;
                document.getElementById('c-uf').value = data.uf;
                document.getElementById('c-num').focus();
            } else {
                notify("CEP não encontrado.", "error");
            }
        } catch(e) {
            console.error(e);
        }
    }
}

async function handleSaveCliente() {
    const idDoc = document.getElementById('c-id-doc').value;
    const documento = document.getElementById('c-doc').value.replace(/\D/g, '');
    const razao = document.getElementById('c-razao').value.trim();
    const apelido = document.getElementById('c-apelido').value.trim();
    
    if (!documento || !razao || !apelido) { notify("CNPJ, Razão Social e Apelido do Local são obrigatórios.", "error"); return; }

    const veiculosAceitos = Array.from(document.querySelectorAll('.veic-btn.selected')).map(btn => btn.innerText);

    const payload = {
        documento: documento,
        ie: document.getElementById('c-ie').value.trim(),
        razao: razao,
        apelido: apelido,
        fantasia: document.getElementById('c-fantasia').value.trim(),
        cep: document.getElementById('c-cep').value.trim(),
        rua: document.getElementById('c-rua').value.trim(),
        numero: document.getElementById('c-num').value.trim(),
        complemento: document.getElementById('c-comp').value.trim(),
        bairro: document.getElementById('c-bairro').value.trim(),
        cidade: document.getElementById('c-cidade').value.trim(),
        uf: document.getElementById('c-uf').value.toUpperCase(),
        contatoNome: document.getElementById('c-contato-nome').value.trim(),
        contatoTel: document.getElementById('c-contato-tel').value.trim(),
        contatoEmail: document.getElementById('c-contato-email').value.trim(),
        horarioRecebimento: document.getElementById('c-horario').value.trim(),
        metodoAgendamento: document.getElementById('c-metodo-agendamento').value,
        sobreposicao: document.getElementById('c-sobreposicao').value,
        dimensoes: document.getElementById('c-dimensoes').value.trim(),
        veiculosPermitidos: veiculosAceitos,
        obsLogistica: document.getElementById('c-obs-logistica').value.trim(),
        user: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    if (idDoc) {
        if (!confirm(`Atualizar cadastro de ${razao}?`)) return;
        const res = await StorageManager.updateCliente(idDoc, payload);
        if (res.success) { notify("Cliente atualizado!"); renderCliente(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    } else {
        if (!confirm(`Cadastrar o cliente ${razao}?`)) return;
        const res = await StorageManager.saveCliente(payload);
        if (res.success) { notify("Cliente cadastrado!"); renderCliente(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    }
}

async function handleEditCliente(id) {
    const c = await StorageManager.getClienteById(id);
    if (!c) return;

    document.getElementById('c-id-doc').value = c.id_doc;
    document.getElementById('c-doc').value = c.documento;
    document.getElementById('c-ie').value = c.ie || '';
    document.getElementById('c-razao').value = c.razao;
    document.getElementById('c-fantasia').value = c.fantasia || '';
    document.getElementById('c-apelido').value = c.apelido || '';
    document.getElementById('c-cep').value = c.cep || '';
    document.getElementById('c-rua').value = c.rua || '';
    document.getElementById('c-num').value = c.numero || '';
    document.getElementById('c-comp').value = c.complemento || '';
    document.getElementById('c-bairro').value = c.bairro || '';
    document.getElementById('c-cidade').value = c.cidade || '';
    document.getElementById('c-uf').value = c.uf || '';
    document.getElementById('c-contato-nome').value = c.contatoNome || '';
    document.getElementById('c-contato-tel').value = c.contatoTel || '';
    document.getElementById('c-contato-email').value = c.contatoEmail || '';
    document.getElementById('c-horario').value = c.horarioRecebimento || '';
    document.getElementById('c-metodo-agendamento').value = c.metodoAgendamento || '';
    document.getElementById('c-sobreposicao').value = c.sobreposicao || 'SIM';
    document.getElementById('c-dimensoes').value = c.dimensoes || '';
    document.getElementById('c-obs-logistica').value = c.obsLogistica || '';

    document.querySelectorAll('.veic-btn').forEach(btn => {
        if (c.veiculosPermitidos && c.veiculosPermitidos.includes(btn.innerText)) {
            btn.classList.add('selected');
        } else {
            btn.classList.remove('selected');
        }
    });

    document.getElementById('cli-status-card').innerText = "EM EDIÇÃO";
    document.getElementById('cli-status-card').className = "status-neon active";
    document.getElementById('btn-save-cli').innerText = "ATUALIZAR DADOS";
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('cli-geral').classList.add('active');
    document.getElementById('tab-cli-geral').classList.add('active');

    notify(`Editando ${c.razao}`, "info");
}

async function handleDeleteCliente(id) {
    if(!confirm("Tem certeza que deseja apagar este cliente?")) return;
    await StorageManager.deleteCliente(id);
    notify("Cliente apagado com sucesso.");
    renderCliente(document.getElementById('workspace'));
}
/* --- MÓDULO MOTORISTA (GERENCIAMENTO DE RISCO & CNH) --- */
async function renderMotorista(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Sem permissão.</p></div>`;
        return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando motoristas...</div>';
    
    // Busca motoristas e transportadoras (para vincular um motorista à transportadora padrão, se houver)
    const [motoristas, transps] = await Promise.all([
        StorageManager.getMotoristas(),
        StorageManager.getTransportadoras()
    ]);

    const transpOptions = transps.map(t => `<option value="${t.razao}">${t.razao}</option>`).join('');
    const sysDate = new Date(SYSTEM_DATE_STR);

    let rows = motoristas.map(m => {
        let isCnhVencida = new Date(m.cnhValidade) < sysDate;
        let cnhColor = isCnhVencida ? '#FF3131' : '#aaa';
        let grColor = m.statusGR === 'LIBERADO' ? '#39FF14' : (m.statusGR === 'BLOQUEADO' ? '#FF3131' : '#FF8200');

        return `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">${m.cpf}</td>
            <td>
                <strong style="color:var(--eletra-aqua);">${m.nome}</strong><br>
                <span style="font-size:0.7rem; color:#888;">${m.telefone || '-'}</span>
            </td>
            <td>
                CNH: ${m.cnh} (Cat: <strong>${m.cnhCategoria}</strong>)<br>
                <span style="font-size:0.7rem; color:${cnhColor}; font-weight:bold;">Validade: ${m.cnhValidade}</span>
            </td>
            <td>
                <span style="font-size:0.7rem; font-weight:bold; color:${grColor}; border:1px solid ${grColor}; padding:2px 5px; border-radius:3px;">${m.statusGR || 'PENDENTE'}</span>
                <br><span style="font-size:0.65rem; color:#888;">${m.transportadora || 'Spot / Autônomo'}</span>
            </td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px 10px; margin-right:5px;" onclick="handleEditMotorista('${m.id_doc}')" title="Editar"><i class="fa-solid fa-pencil"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 10px;" onclick="handleDeleteMotorista('${m.id_doc}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `}).join('');

    if (motoristas.length === 0) rows = `<tr><td colspan="5" style="text-align:center; padding:15px; font-style:italic;">Nenhum motorista cadastrado.</td></tr>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" id="tab-mot-geral" onclick="switchTab('mot-geral')">Ficha do Motorista</button>
                <button class="tab-btn" onclick="switchTab('mot-lista')" style="color:var(--eletra-orange)">Banco de Motoristas (${motoristas.length})</button>
            </div>
            
            <div id="mot-geral" class="tab-content active" style="position:relative;">
                <div id="mot-status-card" class="status-neon active">NOVO CADASTRO</div>
                <input type="hidden" id="m-id-doc">

                <fieldset class="prop-group">
                    <legend>DADOS PESSOAIS</legend>
                    <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>CPF*</label>
                            <input type="text" id="m-cpf" placeholder="Apenas números">
                        </div>
                        <div class="form-row-col">
                            <label>Nome Completo*</label>
                            <input type="text" id="m-nome" placeholder="Nome igual à CNH">
                        </div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>RG</label><input type="text" id="m-rg" placeholder="Número do RG"></div>
                        <div class="form-row-col"><label>Data de Nascimento</label><input type="date" id="m-nascimento"></div>
                        <div class="form-row-col"><label>Celular / WhatsApp*</label><input type="text" id="m-telefone" placeholder="(11) 90000-0000"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>DOCUMENTAÇÃO E CNH</legend>
                    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>Nº Registro CNH*</label>
                            <input type="text" id="m-cnh" placeholder="Número da habilitação">
                        </div>
                        <div class="form-row-col">
                            <label>Categoria*</label>
                            <select id="m-cnh-categoria">
                                <option value="">Selecione...</option>
                                <option value="B">B (Passeio/Utilitário)</option>
                                <option value="C">C (Caminhão/Toco/Truck)</option>
                                <option value="D">D (Ônibus/Micro)</option>
                                <option value="E">E (Carreta/Bitrem)</option>
                            </select>
                        </div>
                        <div class="form-row-col">
                            <label>Validade CNH*</label>
                            <input type="date" id="m-cnh-validade" value="${SYSTEM_DATE_STR}" onchange="validateCNH()">
                        </div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>GERENCIAMENTO DE RISCO E VÍNCULO</legend>
                    <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 10px;">
                        <div class="form-row-col">
                            <label style="color:var(--eletra-orange)">Status na Gerenciadora*</label>
                            <select id="m-status-gr">
                                <option value="PENDENTE">Pendente / Em Análise</option>
                                <option value="LIBERADO">Apto / Liberado</option>
                                <option value="BLOQUEADO">Bloqueado (Não Carrega)</option>
                            </select>
                        </div>
                        <div class="form-row-col">
                            <label>Transportadora Padrão (Opcional)</label>
                            <select id="m-transportadora">
                                <option value="">-- Spot / Agregado Autônomo --</option>
                                ${transpOptions}
                            </select>
                        </div>
                    </div>
                </fieldset>

                <div class="props-footer" style="margin-top: 20px;">
                    <button id="btn-save-mot" class="mark-btn action apply" onclick="handleSaveMotorista()">SALVAR MOTORISTA</button>
                    <button class="mark-btn action" onclick="renderMotorista(document.getElementById('workspace'))">CANCELAR</button>
                </div>
            </div>

            <div id="mot-lista" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>CPF</th><th>Motorista / Contato</th><th>CNH / Categoria</th><th>Status Risco / Vínculo</th><th>Ações</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
    
    validateCNH();
}

function validateCNH() {
    const validadeEl = document.getElementById('m-cnh-validade');
    const statusCard = document.getElementById('mot-status-card');
    if (!validadeEl || !statusCard) return;

    const sysDate = new Date(SYSTEM_DATE_STR);
    const validade = new Date(validadeEl.value);

    if (validade < sysDate) {
        validadeEl.classList.add('input-error');
        statusCard.innerText = "ATENÇÃO: CNH VENCIDA"; 
        statusCard.className = "status-neon inactive";
    } else {
        validadeEl.classList.remove('input-error');
        if (!statusCard.innerText.includes("EDIÇÃO")) {
            statusCard.innerText = "CNH VÁLIDA"; 
        }
        statusCard.className = "status-neon active";
    }
}

async function handleSaveMotorista() {
    const idDoc = document.getElementById('m-id-doc').value;
    const cpf = document.getElementById('m-cpf').value.replace(/\D/g, '');
    const nome = document.getElementById('m-nome').value.trim();
    const cnh = document.getElementById('m-cnh').value.trim();
    const cnhCategoria = document.getElementById('m-cnh-categoria').value;
    const cnhValidade = document.getElementById('m-cnh-validade').value;

    if (!cpf || !nome || !cnh || !cnhCategoria || !cnhValidade) { 
        notify("CPF, Nome e dados da CNH são obrigatórios.", "error"); 
        return; 
    }

    if (new Date(cnhValidade) < new Date(SYSTEM_DATE_STR)) {
        notify("Atenção: A CNH informada está vencida!", "error");
    }

    const payload = {
        cpf: cpf,
        nome: nome,
        rg: document.getElementById('m-rg').value.trim(),
        nascimento: document.getElementById('m-nascimento').value,
        telefone: document.getElementById('m-telefone').value.trim(),
        cnh: cnh,
        cnhCategoria: cnhCategoria,
        cnhValidade: cnhValidade,
        statusGR: document.getElementById('m-status-gr').value,
        transportadora: document.getElementById('m-transportadora').value,
        user: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    if (idDoc) {
        if (!confirm(`Atualizar o motorista ${nome}?`)) return;
        const res = await StorageManager.updateMotorista(idDoc, payload);
        if (res.success) { notify("Motorista atualizado!"); renderMotorista(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    } else {
        if (!confirm(`Cadastrar o motorista ${nome}?`)) return;
        const res = await StorageManager.saveMotorista(payload);
        if (res.success) { notify("Motorista cadastrado!"); renderMotorista(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    }
}

async function handleEditMotorista(id) {
    const m = await StorageManager.getMotoristaById(id);
    if (!m) return;

    document.getElementById('m-id-doc').value = m.id_doc;
    document.getElementById('m-cpf').value = m.cpf;
    document.getElementById('m-nome').value = m.nome;
    document.getElementById('m-rg').value = m.rg || '';
    document.getElementById('m-nascimento').value = m.nascimento || '';
    document.getElementById('m-telefone').value = m.telefone || '';
    
    document.getElementById('m-cnh').value = m.cnh;
    document.getElementById('m-cnh-categoria').value = m.cnhCategoria;
    document.getElementById('m-cnh-validade').value = m.cnhValidade;
    
    document.getElementById('m-status-gr').value = m.statusGR || 'PENDENTE';
    document.getElementById('m-transportadora').value = m.transportadora || '';

    document.getElementById('mot-status-card').innerText = "EM EDIÇÃO";
    document.getElementById('mot-status-card').className = "status-neon active";
    document.getElementById('btn-save-mot').innerText = "ATUALIZAR DADOS";
    
    // Força a aba
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('mot-geral').classList.add('active');
    document.getElementById('tab-mot-geral').classList.add('active');

    validateCNH();
    notify(`Editando ${m.nome}`, "info");
}

async function handleDeleteMotorista(id) {
    if(!confirm("Tem certeza que deseja apagar este motorista da base?")) return;
    await StorageManager.deleteMotorista(id);
    notify("Motorista apagado com sucesso.");
    renderMotorista(document.getElementById('workspace'));
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
    const tipoVeiculo = document.getElementById('input-tipo-veiculo').value; 
    const obs = document.getElementById('input-obs').value.trim();

    if (selectedSlots.length === 0) { notify("Selecione um horário.", "error"); return; }
    if (!poMat || !nf || !comprador || !poFrete) { notify("Preencha campos obrigatórios (*).", "error"); return; }

    const conflict = (await StorageManager.getAppointments()).find(a => a.date === date && a.location === location && selectedSlots.includes(a.time));
    if (conflict) { notify(`ERRO: Horário ${conflict.time} acabou de ser ocupado.`, "error"); updateInboundSlots(); return; }

    if (!confirm(`Confirmar agendamento?`)) return;
    const loteTimestamp = new Date().toISOString();

    const newBookings = selectedSlots.map(time => ({
        id: Date.now() + Math.random(),
        date, time, location,
        userId: CURRENT_USER.id,
        userName: CURRENT_USER.name,
        timestamp: loteTimestamp, // Usa a mesma etiqueta de tempo para todos os slots
        tipoFluxo: 'INBOUND',
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
    
    // 1. LÓGICA DE AGRUPAMENTO (Por Agendamento exato)
    const groupedAppts = {};
    currentAppts.forEach(a => {
        const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`; 
        if(!groupedAppts[key]) {
            groupedAppts[key] = {
                timeStart: a.time,
                timeEnd: a.time,
                details: a.details,
                userName: a.userName
            };
        }
        if (a.time < groupedAppts[key].timeStart) groupedAppts[key].timeStart = a.time;
        if (a.time > groupedAppts[key].timeEnd) groupedAppts[key].timeEnd = a.time;
    });

    const calcRealEnd = (timeStr) => {
        let [h, m] = timeStr.split(':').map(Number);
        m += 10;
        if (m >= 60) { h++; m -= 60; }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    let html = `<h4 style="color:var(--eletra-aqua); margin-bottom:5px; border-bottom:1px solid #444; font-size:0.75rem;">Agenda Vigente (${date.split('-').reverse().join('/')} - ${location})</h4>`;
    
    const groupedValues = Object.values(groupedAppts);
    if (groupedValues.length === 0) { html += `<div style="font-style:italic; color:#777; font-size:0.7rem;">Vazio.</div>`; } 
    else {
        groupedValues.sort((a, b) => a.timeStart.localeCompare(b.timeStart)).forEach(g => { 
            const timeWindow = `${g.timeStart} às ${calcRealEnd(g.timeEnd)}`;
            const tipoDesc = g.details.tipoVeiculo ? ` | Veículo: ${g.details.tipoVeiculo}` : '';
            html += `<div style="border-bottom:1px solid #333; padding:4px 0; font-size:0.75rem;"><strong style="color:#fff;">${timeWindow}</strong> | Sol: ${g.details.solicitante||'-'} | Comp: ${g.details.comprador||'-'}${tipoDesc} | <span style="color:#888;">Agendado: ${g.userName}</span></div>`; 
        });
    }
    
    const allLogs = await StorageManager.getLogs();
    html += `<h4 style="color:var(--eletra-orange); margin-top:15px; margin-bottom:5px; border-top:1px solid #444; font-size:0.75rem;">Últimos Eventos do Sistema</h4>`;
    allLogs.forEach(l => {
        html += `<div style="border-bottom:1px solid #333; padding:2px 0; font-family:monospace; font-size:0.65rem;"><span style="color:#666;">[${new Date(l.timestamp).toLocaleString('pt-BR')}]</span> <span style="color:${l.action.includes('CANCEL')?'#FF3131':'#00D4FF'}">${l.action}</span> ${l.user}: ${l.details}</div>`;
    });
    div.innerHTML = html;
}

/* --- MÓDULO MONITORAMENTO (TORRE DE CONTROLE) --- */
async function renderMonitor(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando Torre de Controle...</div>';
    // CORREÇÃO: Memória de Data e Captura Segura
    const dateInput = document.getElementById('monitor-date');
    const filterDate = window.currentMonitorDate || SYSTEM_DATE_STR;
    window.currentMonitorDate = filterDate; // Memoriza a data para não resetar durante a digitação

    const allAppts = await StorageManager.getAppointments();
    const dailyAppts = allAppts.filter(a => a.date === filterDate).sort((a, b) => a.time.localeCompare(b.time));
    
    // LÓGICA DE AGRUPAMENTO (Agrupa por PO + NF + Local)
    const groupedAppts = {};
    dailyAppts.forEach(a => {
        const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`;
        
        if(!groupedAppts[key]) {
            groupedAppts[key] = {
                ids: [], 
                timeStart: a.time,
                timeEnd: a.time,
                details: a.details,
                location: a.location,
                userName: a.userName,
                status: a.status || 'AGENDADO',
                statusObs: a.statusObs || '',
                motivoOcorrencia: a.motivoOcorrencia || ''
            };
        }
        
        groupedAppts[key].ids.push(a.id_doc);
        
        if (a.time < groupedAppts[key].timeStart) groupedAppts[key].timeStart = a.time;
        if (a.time > groupedAppts[key].timeEnd) groupedAppts[key].timeEnd = a.time;
    });

    let countAgendado = 0, countPatio = 0, countFim = 0, countOcorrencia = 0;

    // Helper para somar 10 minutos no último slot e mostrar a janela real (ex: 08:00 às 08:30)
    const calcRealEnd = (timeStr) => {
        let [h, m] = timeStr.split(':').map(Number);
        m += 10;
        if (m >= 60) { h++; m -= 60; }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    // Renderiza usando os grupos com alinhamento centralizado
    let rows = Object.values(groupedAppts).map(g => {
        let status = g.status || 'AGENDADO';
        const realEndTime = calcRealEnd(g.timeEnd);
        
        // ATRASO AUTOMÁTICO VINCULADO AO RELÓGIO (Usando o final real da janela)
        if (status === 'AGENDADO') {
            if (filterDate < SYSTEM_DATE_STR) {
                status = 'ATRASADO';
            } else if (filterDate === SYSTEM_DATE_STR) {
                const now = new Date();
                const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                if (realEndTime < currentTime) { status = 'ATRASADO'; }
            }
        }

        let statusColor = '#aaa';

        if (status === 'AGENDADO') { countAgendado++; statusColor = 'var(--eletra-aqua)'; }
        else if (status === 'CHEGOU' || status === 'EM DESCARGA') { countPatio++; statusColor = 'var(--eletra-orange)'; }
        else if (status === 'FINALIZADO') { countFim++; statusColor = '#39FF14'; }
        else if (status === 'ATRASADO' || status === 'ANOMALIA') { countOcorrencia++; statusColor = '#FF3131'; }

        // Como cada slot tem 10 min, a exibição será sempre um intervalo contínuo
        let timeWindow = `${g.timeStart} às ${realEndTime}`;
        let idsString = g.ids.join(',');

        return `
        <tr style="border-bottom:1px solid #333; text-align:center;">
            <td style="padding:10px; font-weight:bold; color:var(--eletra-aqua); font-size:1.1rem; white-space:nowrap;">${timeWindow}</td>
            <td>
                <span style="font-weight:bold;">${g.details.transp || 'Não Informada'}</span><br>
                <span style="font-size:0.7rem; color:#888;">Veículo: ${g.details.tipoVeiculo || '-'}</span>
            </td>
            <td>
                PO: ${g.details.poMat}<br>
                <span style="font-size:0.7rem; color:#888;">NF: ${g.details.nf}</span>
            </td>
            <td>${g.location}</td>
            <td>
                <span style="border: 1px solid ${statusColor}; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold;">
                    ${status}
                </span>
                ${g.details.obs ? `<br><span style="font-size:0.65rem; color:var(--eletra-aqua); margin-top:6px; display:block;"><i class="fa-solid fa-circle-info"></i> Plan: ${g.details.obs}</span>` : ''}
                ${g.motivoOcorrencia ? `<span style="font-size:0.65rem; color:#FF8200; margin-top:4px; display:block;">Motivo: ${g.motivoOcorrencia}</span>` : ''}
                ${g.statusObs ? `<span style="font-size:0.65rem; color:#888; margin-top:2px; display:block;">Obs: ${g.statusObs}</span>` : ''}
            </td>
            <td>
                <div style="display: flex; gap: 5px; justify-content: center; flex-wrap: wrap; width: 100%; max-width: 170px; margin: 0 auto;">
                    <button class="mark-btn" style="border-color:var(--eletra-orange); color:var(--eletra-orange); padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="quickStatusUpdate('${idsString}', 'CHEGOU')">CHEGADA</button>
                    <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="quickStatusUpdate('${idsString}', 'EM DESCARGA')">DESCARGA</button>
                    <button class="mark-btn" style="border-color:#39FF14; color:#39FF14; padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="quickStatusUpdate('${idsString}', 'FINALIZADO')">SAÍDA</button>
                    <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="openAnomaliaModal('${idsString}')">ANOMALIA</button>
                </div>
            </td>
        </tr>
        `;
    }).join('');

    if (Object.keys(groupedAppts).length === 0) rows = `<tr><td colspan="6" style="text-align:center; padding:15px; font-style:italic;">Nenhum veículo agendado para esta data.</td></tr>`;
    
    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px; position:relative;">
            <div class="props-tabs">
                <button class="tab-btn" onclick="switchTab('mon-outbound')">Monitor Outbound</button>
            </div>

            <div id="mon-inbound" class="tab-content active">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; background:#1a1d21; padding:15px; border-radius:4px; border:1px solid var(--border-color); flex-wrap:wrap; gap:15px;">
                    <div>
                        <label style="font-size:0.8rem; color:#aaa; margin-right:10px;">Data Base:</label>
                        <input type="date" id="monitor-date" value="${filterDate}" onblur="updateMonitorDate()" onkeydown="if(event.key === 'Enter') updateMonitorDate()" style="background:#0b0e11; color:white; border:1px solid #444; padding:5px; border-radius:3px;">
                        <button class="mark-btn" style="margin-left:10px;" onclick="updateMonitorDate()"><i class="fa-solid fa-rotate-right"></i> Atualizar</button>
                    </div>
                    <div style="display:flex; gap:25px;">
                        <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:var(--eletra-aqua);">${countAgendado}</div><div style="font-size:0.65rem; color:#888;">AGENDADOS</div></div>
                        <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:var(--eletra-orange);">${countPatio}</div><div style="font-size:0.65rem; color:#888;">NO PÁTIO</div></div>
                        <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:#39FF14;">${countFim}</div><div style="font-size:0.65rem; color:#888;">FINALIZADOS</div></div>
                        <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:#FF3131;">${countOcorrencia}</div><div style="font-size:0.65rem; color:#888;">OCORRÊNCIAS</div></div>
                    </div>
                </div>

                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th style="text-align:center;">Hora</th>
                                <th style="text-align:center;">Transportadora / Veículo</th>
                                <th style="text-align:center;">Documentos</th>
                                <th style="text-align:center;">Local</th>
                                <th style="text-align:center;">Status Operacional</th>
                                <th style="text-align:center;">Ação</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
            
            <div id="mon-outbound" class="tab-content"><p style="padding:40px; text-align:center;">Monitoramento Outbound em construção.</p></div>

            <div id="modal-backdrop" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.8); z-index:9998;"></div>
            
            <div id="status-modal" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:var(--bg-asfalto); padding:20px; border-radius:8px; border:1px solid #FF3131; z-index:9999; width:90%; max-width:400px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                <h3 style="color:#FF3131; margin-bottom:15px; border-bottom:1px solid #333; padding-bottom:10px;"><i class="fa-solid fa-triangle-exclamation"></i> Registrar Anomalia</h3>
                <input type="hidden" id="modal-id-doc">

                <div class="form-row-col" style="margin-bottom:15px;">
                    <label style="color:var(--eletra-orange)">Causa Raiz / Motivo:*</label>
                    <select id="modal-motivo" style="width:100%; padding:10px; background:#0B0E11; color:white; border:1px solid #444; border-radius:4px;">
                        <option value="">Selecione a raiz do problema...</option>
                        <option value="No-Show">No-Show</option>
                        <option value="PO Material divergente ou ausente">PO Material divergente ou ausente</option>
                        <option value="NF Material divergente ou ausente">NF Material divergente ou ausente</option>
                        <option value="PO Frete divergente ou ausente">PO Frete divergente ou ausente</option>
                        <option value="CTRC divergente ou ausente">CTRC divergente ou ausente</option>
                        <option value="Documento divergente ou ausente">Documento divergente ou ausente</option>
                        <option value="Divergência na conferência">Divergência na conferência</option>
                        <option value="Motorista sem EPI">Motorista sem EPI</option>
                        <option value="Fila por atraso">Fila por atraso</option>
                        <option value="Carga avariada">Carga avariada</option>
                        <option value="Veículo inadequado">Veículo inadequado</option>
                        <option value="Outros">Outros</option>
                    </select>
                </div>

                <div class="form-row-col" style="margin-bottom:20px;">
                    <label>Observações Adicionais:</label>
                    <textarea id="modal-obs" rows="3" style="width:100%; padding:10px; background:#0B0E11; color:white; border:1px solid #444; border-radius:4px; resize:none;" placeholder="Descreva os detalhes da anomalia (Opcional)..."></textarea>
                </div>

                <div style="display:flex; justify-content:flex-end; gap:10px;">
                    <button class="mark-btn action" onclick="closeStatusModal()">CANCELAR</button>
                    <button class="mark-btn action" style="border-color:#FF3131; color:#FF3131;" onclick="confirmAnomalia()">SALVAR ANOMALIA</button>
                </div>
            </div>
        </div>
    `;
}

// --- CONTROLE DE DATA DO MONITOR ---
window.updateMonitorDate = function() {
    const dateInput = document.getElementById('monitor-date');
    if (!dateInput) return;

    let newDate = dateInput.value;
    
    // Regra de Negócio: Se a data estiver vazia ou for inválida após sair do campo, volta para hoje
    if (!newDate) {
        newDate = SYSTEM_DATE_STR;
        notify("Data inválida. Retornando para a visão de hoje.", "info");
    }
    
    window.currentMonitorDate = newDate;
    renderMonitor(document.getElementById('workspace')); // Atualiza a tela com a nova data
}

// Controles do Modal de Status
// 1. Atualização rápida sem Modal (Chegada, Descarga, Saída)
async function quickStatusUpdate(idsString, newStatus) {
    if (!confirm(`Confirma o apontamento de: ${newStatus}?`)) return;
    
    const id_docs = idsString.split(',');
    
    // Envia status novo, sem obs e sem motivo
    const res = await StorageManager.updateStatusBatch(id_docs, newStatus, "", "");
    if(res.success) {
        notify(`Status atualizado para ${newStatus}!`);
        renderMonitor(document.getElementById('workspace')); // Atualiza a tabela
    } else {
        notify("Erro ao atualizar status.", "error");
    }
}

// 2. Abertura do Modal apenas para Anomalia
function openAnomaliaModal(idsString) {
    document.getElementById('modal-id-doc').value = idsString;
    document.getElementById('modal-motivo').value = "";
    document.getElementById('modal-obs').value = "";
    
    document.getElementById('modal-backdrop').style.display = 'block';
    document.getElementById('status-modal').style.display = 'block';
}

function closeStatusModal() {
    document.getElementById('modal-backdrop').style.display = 'none';
    document.getElementById('status-modal').style.display = 'none';
}

// 3. Salvar Anomalia com validação de Causa Raiz
async function confirmAnomalia() {
    const idsString = document.getElementById('modal-id-doc').value;
    const motivo = document.getElementById('modal-motivo').value;
    const obs = document.getElementById('modal-obs').value.trim();

    if (!motivo) {
        notify("Atenção: É obrigatório selecionar a Causa Raiz da Anomalia!", "error");
        document.getElementById('modal-motivo').focus();
        return;
    }

    const id_docs = idsString.split(',');
    
    // Salva forçando o status para 'ANOMALIA'
    const res = await StorageManager.updateStatusBatch(id_docs, 'ANOMALIA', obs, motivo);
    
    if(res.success) {
        notify(`Anomalia registada com sucesso!`, "error");
        closeStatusModal();
        renderMonitor(document.getElementById('workspace')); 
    } else {
        notify("Erro ao registar anomalia.", "error");
    }
}

/* =========================================
   MÓDULO: OCORRÊNCIAS (BUCKET LIST)
   ========================================= */
async function renderOcorrencias(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Procurando anomalias na base...</div>';
    
    const allAppts = await StorageManager.getAppointments();
    const anomalias = allAppts.filter(a => a.status === 'ANOMALIA' || a.anomaliaTratada === true);
    
    // 1. AGRUPAMENTO INTELIGENTE (Mesma lógica do Monitor)
    const groupedAnomalias = {};
    anomalias.forEach(a => {
        const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`;
        if (!groupedAnomalias[key]) {
            groupedAnomalias[key] = {
                ids: [],
                timeStart: a.time,
                timeEnd: a.time,
                date: a.date,
                details: a.details,
                tipoFluxo: a.tipoFluxo,
                motivoOcorrencia: a.motivoOcorrencia,
                statusObs: a.statusObs,
                statusUpdatedAt: a.statusUpdatedAt,
                statusUpdatedBy: a.statusUpdatedBy,
                anomaliaTratada: a.anomaliaTratada,
                planoAcao: a.planoAcao
            };
        }
        groupedAnomalias[key].ids.push(a.id_doc);
        if (a.time < groupedAnomalias[key].timeStart) groupedAnomalias[key].timeStart = a.time;
        if (a.time > groupedAnomalias[key].timeEnd) groupedAnomalias[key].timeEnd = a.time;
        
        // Se um slot antigo foi tratado, o grupo herda a tratativa
        if (a.anomaliaTratada) {
            groupedAnomalias[key].anomaliaTratada = true;
            groupedAnomalias[key].planoAcao = a.planoAcao;
        }
    });

    const calcRealEnd = (timeStr) => {
        let [h, m] = timeStr.split(':').map(Number);
        m += 10;
        if (m >= 60) { h++; m -= 60; }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    const groupedArray = Object.values(groupedAnomalias);

    // Separa entre Pendentes e Tratadas baseadas nos GRUPOS
    const pendentes = groupedArray.filter(g => !g.anomaliaTratada).sort((a,b) => new Date(b.date) - new Date(a.date));
    const tratadas = groupedArray.filter(g => g.anomaliaTratada).sort((a,b) => new Date(b.planoAcao.timestamp) - new Date(a.planoAcao.timestamp));

    // BUCKET LIST: PENDENTES (Abre formulário de Ação)
    let htmlPendentes = pendentes.map(g => {
        const timeWindow = `${g.timeStart} às ${calcRealEnd(g.timeEnd)}`;
        const idsString = g.ids.join(',');
        const elementId = g.ids[0]; // Usado para abrir/fechar o card corretamente

        return `
        <div class="card" style="border-left: 4px solid #FF3131; padding: 15px; margin-bottom: 10px; cursor: pointer; transition: 0.2s;" onclick="toggleAnomaly('card-${elementId}')" onmouseover="this.style.background='#222'" onmouseout="this.style.background='var(--bg-asfalto)'">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <span style="background: var(--eletra-aqua); color: var(--bg-petroleo); padding: 2px 6px; border-radius: 3px; font-size: 0.65rem; font-weight: bold; margin-right: 8px; vertical-align: middle;">${g.tipoFluxo || 'INBOUND'}</span>
                    <strong style="color: var(--eletra-aqua); font-size: 1.1rem; vertical-align: middle;">${g.details.fornecedor || g.details.transp || 'Não Informado'}</strong>
                    <span style="font-size: 0.8rem; color: #888; margin-left: 10px;">Data do Agendamento: ${g.date.split('-').reverse().join('/')} - <strong style="color:white;">${timeWindow}</strong></span><br>
                    <span style="color: #FF3131; font-weight: bold; font-size: 0.85rem; margin-top:5px; display:inline-block;"><i class="fa-solid fa-triangle-exclamation"></i> Causa Raiz: ${g.motivoOcorrencia}</span>
                </div>
                <div><i class="fa-solid fa-chevron-down" style="color: #aaa;"></i></div>
            </div>
            
            <div id="card-${elementId}" style="display: none; margin-top: 15px; padding-top: 15px; border-top: 1px solid #333; cursor: default;" onclick="event.stopPropagation()">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; font-size: 0.8rem; background: #0B0E11; padding: 10px; border-radius: 4px;">
                    <div>
                        <span style="color: #888;">PO:</span> <strong>${g.details.poMat}</strong><br>
                        <span style="color: #888;">NF:</span> <strong>${g.details.nf}</strong><br>
                        <span style="color: #888;">Transportadora:</span> <strong>${g.details.transp || '-'}</strong>
                    </div>
                    <div>
                        <span style="color: #888;">Comprador:</span> <strong>${g.details.comprador}</strong><br>
                        <span style="color: #888;">Solicitante:</span> <strong>${g.details.solicitante || '-'}</strong><br>
                        <span style="color: #888;">Obs Portaria:</span> <span style="color: var(--eletra-orange);">${g.statusObs || 'Nenhuma'}</span>
                    </div>
                </div>
                
                <div style="background: #1A1D21; padding: 15px; border-radius: 4px; border: 1px dashed #444;">
                    <h4 style="color: var(--eletra-aqua); margin-bottom: 10px; font-size: 0.85rem;"><i class="fa-solid fa-clipboard-check"></i> Plano de Ação Rápido (Tratativa)</h4>
                    <div class="form-row-col" style="margin-bottom: 10px;">
                        <textarea id="acao-${elementId}" rows="2" style="width: 100%; padding: 10px; background: #0B0E11; color: white; border: 1px solid #444; border-radius: 4px; resize: none;" placeholder="Descreva o que foi feito. Ex: Fornecedor contatado. Reagendado para amanhã..."></textarea>
                    </div>
                    <div style="display: flex; gap: 10px; justify-content: space-between; align-items: center; flex-wrap: wrap;">
                        <button class="mark-btn" style="border-color: #aaa; color: #aaa; font-size: 0.7rem;" 
                            onclick="copyToClipboardHtml('${g.details.poMat}', '${g.details.nf}', '${g.details.fornecedor}', '${g.motivoOcorrencia}', '${g.statusObs}', '${g.details.comprador}', '${g.details.solicitante}', '${g.date.split('-').reverse().join('/')} - ${timeWindow}', '${g.statusUpdatedAt ? new Date(g.statusUpdatedAt).toLocaleString('pt-BR') : 'Data não registrada'}', '${g.statusUpdatedBy || 'Sistema'}', '${g.tipoFluxo || 'INBOUND'}')">
                            <i class="fa-solid fa-envelope"></i> COPIAR P/ E-MAIL
                        </button>
                        <button class="mark-btn action apply" style="font-size: 0.75rem;" onclick="confirmTratativa('${idsString}', '${elementId}')"><i class="fa-solid fa-check"></i> SALVAR E ENCERRAR</button>
                    </div>
                </div>
            </div>
        </div>
        `;
    }).join('');

    if(pendentes.length === 0) htmlPendentes = `<div style="text-align:center; padding:40px; color:#888; font-style:italic;"><i class="fa-solid fa-check-double" style="font-size:2rem; color:#39FF14; display:block; margin-bottom:10px;"></i>Nenhuma ocorrência pendente! Tudo limpo.</div>`;

    // BUCKET LIST: TRATADAS (Modo Leitura)
    let htmlTratadas = tratadas.map(g => {
        const timeWindow = `${g.timeStart} às ${calcRealEnd(g.timeEnd)}`;
        const elementId = g.ids[0];

        return `
        <div class="card" style="border-left: 4px solid #39FF14; padding: 15px; margin-bottom: 10px; cursor: pointer;" onclick="toggleAnomaly('card-${elementId}')">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <span style="background: var(--eletra-aqua); color: var(--bg-petroleo); padding: 2px 6px; border-radius: 3px; font-size: 0.65rem; font-weight: bold; margin-right: 8px; vertical-align: middle;">${g.tipoFluxo || 'INBOUND'}</span>
                    <strong style="color: var(--eletra-aqua); font-size: 1.1rem; vertical-align: middle;">${g.details.fornecedor || g.details.transp || 'Não Informado'}</strong>
                    <span style="font-size: 0.8rem; color: #888; margin-left: 10px;">Data do Agendamento: ${g.date.split('-').reverse().join('/')} - <strong style="color:white;">${timeWindow}</strong></span><br>
                    <span style="color: #39FF14; font-weight: bold; font-size: 0.85rem; margin-top:5px; display:inline-block;"><i class="fa-solid fa-check"></i> Tratado por: ${g.planoAcao.responsavel}</span>
                </div>
                <div><i class="fa-solid fa-chevron-down" style="color: #aaa;"></i></div>
            </div>
            
            <div id="card-${elementId}" style="display: none; margin-top: 15px; padding-top: 15px; border-top: 1px solid #333; cursor: default;" onclick="event.stopPropagation()">
                <div style="font-size: 0.8rem; margin-bottom: 10px;">
                    <span style="color: #888;">Anomalia Original:</span> <strong style="color: #FF3131;">${g.motivoOcorrencia}</strong> (PO: ${g.details.poMat} / NF: ${g.details.nf})
                </div>
                <div style="background: rgba(57, 255, 20, 0.05); padding: 10px; border-radius: 4px; border: 1px solid #39FF14; font-size: 0.85rem; color: #ddd;">
                    <strong style="color: #39FF14;">Plano de Ação Executado:</strong><br>
                    ${g.planoAcao.acao}
                </div>
            </div>
        </div>
        `;
    }).join('');

    if(tratadas.length === 0) htmlTratadas = `<div style="text-align:center; padding:20px; color:#888;">Nenhuma tratativa no histórico.</div>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('oc-pendentes')">Fila de Pendências (<span style="color:#FF3131; font-weight:bold;">${pendentes.length}</span>)</button>
                <button class="tab-btn" onclick="switchTab('oc-tratadas')">Histórico Tratadas (<span style="color:#39FF14; font-weight:bold;">${tratadas.length}</span>)</button>
            </div>
            
            <div id="oc-pendentes" class="tab-content active" style="background: var(--bg-petroleo);">
                ${htmlPendentes}
            </div>
            
            <div id="oc-tratadas" class="tab-content" style="background: var(--bg-petroleo);">
                ${htmlTratadas}
            </div>
        </div>
    `;
}

// Expande ou retrai o Card da Ocorrência
window.toggleAnomaly = function(id) {
    const card = document.getElementById(id);
    if(card) { card.style.display = card.style.display === 'none' ? 'block' : 'none'; }
}

// Salva a ação e encerra a ocorrência em LOTE
window.confirmTratativa = async function(idsString, elementId) {
    const acao = document.getElementById(`acao-${elementId}`).value.trim();
    if(!acao) { notify("Por favor, descreva a ação corretiva antes de encerrar.", "error"); return; }
    
    if(!confirm("Tem certeza que deseja salvar esta tratativa e encerrar a anomalia para todo o agrupamento?")) return;
    
    const plano = {
        acao: acao,
        responsavel: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };
    
    const res = await StorageManager.saveTratativa(idsString, plano);
    if(res.success) {
        notify("Ocorrência encerrada com sucesso!", "success");
        renderOcorrencias(document.getElementById('workspace')); // Atualiza a tela
    } else {
        notify(res.msg, "error");
    }
}

// O botão mágico: Gera Tabela HTML e copia para a Área de Transferência
window.copyToClipboardHtml = function(po, nf, forn, motivo, obs, comp, sol, dataAg, dataAnom, userAnom, fluxo) {
    const html = `
        <div style="font-family: Arial, sans-serif; color: #333;">
            <h3 style="color: #FF3131; border-bottom: 2px solid #FF3131; padding-bottom: 5px; margin-top: 0;">🚨 Alerta de Ocorrência Logística - ${fluxo || 'INBOUND'}</h3>
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; border-color: #ccc;">
                <tr style="background-color: #f9f9f9;">
                    <th style="text-align: left; width: 35%; color: #555;">Fornecedor</th>
                    <td style="font-weight: bold; color: #000;">${forn || 'Não informado no Agendamento'}</td>
                </tr>
                <tr>
                    <th style="text-align: left; color: #555;">Nota Fiscal / PO</th>
                    <td><strong>NF:</strong> ${nf} &nbsp;|&nbsp; <strong>PO:</strong> ${po}</td>
                </tr>
                <tr style="background-color: #f9f9f9;">
                    <th style="text-align: left; color: #555;">Janela Agendada</th>
                    <td style="font-weight: bold;">${dataAg}</td>
                </tr>
                <tr>
                    <th style="text-align: left; color: #FF3131;">Causa Raiz da Falha</th>
                    <td style="font-weight: bold; color: #FF3131;">${motivo}</td>
                </tr>
                <tr style="background-color: #f9f9f9;">
                    <th style="text-align: left; color: #555;">Observação (Portaria)</th>
                    <td>${obs || 'Sem observações adicionais.'}</td>
                </tr>
                <tr>
                    <th style="text-align: left; color: #555;">Registro da Anomalia</th>
                    <td style="font-size: 0.9em;">
                        <strong>Apontado em:</strong> ${dataAnom}<br>
                        <strong>Apontado por:</strong> ${userAnom}
                    </td>
                </tr>
                <tr style="background-color: #f9f9f9;">
                    <th style="text-align: left; color: #555;">Equipe Interna</th>
                    <td><strong>Comprador:</strong> ${comp} &nbsp;|&nbsp; <strong>Solicitante:</strong> ${sol || '-'}</td>
                </tr>
            </table>
            <br>
            <p style="margin: 5px 0;">Prezados,</p>
            <p style="margin: 5px 0;">Por favor, verifiquem o ocorrido acima e nos retornem com o plano de ação o mais breve possível para não impactarmos a operação.</p>
        </div>
    `;
    
    // Truque para copiar o HTML rico (Tabela com cores)
    const tempElement = document.createElement("div");
    tempElement.innerHTML = html;
    document.body.appendChild(tempElement);
    
    const range = document.createRange();
    range.selectNode(tempElement);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    
    try {
        document.execCommand("copy");
        notify("Tabela corporativa copiada! Cole no corpo do seu e-mail.", "info");
    } catch (err) {
        notify("Erro ao copiar para a área de transferência.", "error");
    }
    
    window.getSelection().removeAllRanges();
    document.body.removeChild(tempElement);
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
    
    // Função interna de Agrupamento para a Impressão
    const generateGroupedRows = (list) => {
        if(list.length === 0) return '<tr><td colspan="7" style="text-align:center;">Nenhum agendamento</td></tr>';
        
        const calcRealEnd = (timeStr) => {
            let [h, m] = timeStr.split(':').map(Number);
            m += 10;
            if (m >= 60) { h++; m -= 60; }
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
        };

        const grouped = {};
        list.forEach(a => {
            const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`;
            if(!grouped[key]) {
                grouped[key] = {
                    timeStart: a.time,
                    timeEnd: a.time,
                    details: a.details,
                    userName: a.userName
                };
            }
            if (a.time < grouped[key].timeStart) grouped[key].timeStart = a.time;
            if (a.time > grouped[key].timeEnd) grouped[key].timeEnd = a.time;
        });
        
        return Object.values(grouped).sort((a, b) => a.timeStart.localeCompare(b.timeStart)).map(g => {
            const timeWindow = `${g.timeStart} às ${calcRealEnd(g.timeEnd)}`;
            const transpInfo = g.details.tipoVeiculo ? `${g.details.transp||'-'} (${g.details.tipoVeiculo})` : (g.details.transp||'-');
            return `<tr><td style="white-space:nowrap;"><b>${timeWindow}</b></td><td>${transpInfo}</td><td>${g.details.ctrc||'-'}</td><td>${g.details.solicitante||'-'}</td><td>${g.details.comprador||'-'}</td><td>${g.userName}</td><td>PO: ${g.details.poMat} / NF: ${g.details.nf}</td></tr>`;
        }).join('');
    };

    const win = window.open('', '', 'height=800,width=950');
    win.document.write(`<html><head><title>Agenda EletraLog</title><style>body{font-family:Arial,sans-serif;font-size:12px}table{width:100%;border-collapse:collapse;margin-bottom:20px;}th,td{border:1px solid #ccc;padding:8px;text-align:left;}th{background:#eee}</style></head><body><h1>Agenda EletraLog - ${date.split('-').reverse().join('/')}</h1><h2>DOCA</h2><table><thead><tr><th>Horário(s)</th><th>Transp. (Veículo)</th><th>CTRC</th><th>Solicitante</th><th>Comprador</th><th>Usuário Logado</th><th>Ref (PO / NF)</th></tr></thead><tbody>${generateGroupedRows(doca)}</tbody></table><h2>PORTARIA</h2><table><thead><tr><th>Horário(s)</th><th>Transp. (Veículo)</th><th>CTRC</th><th>Solicitante</th><th>Comprador</th><th>Usuário Logado</th><th>Ref (PO / NF)</th></tr></thead><tbody>${generateGroupedRows(portaria)}</tbody></table><p style="text-align:right; font-size:10px; color:#666;">Impresso em: ${new Date().toLocaleString('pt-BR')}</p></body></html>`);
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