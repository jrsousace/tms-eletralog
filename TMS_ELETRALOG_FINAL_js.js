/* --- CONFIGURAÇÃO GLOBAL --- */
const SYSTEM_DATE_STR = new Date().toISOString().split('T')[0]; 
let CURRENT_USER = null;

const ROLE_PERMISSIONS = {
    'MASTER':   { level: 4, label: 'DESENVOLVIMENTO', canManageUsers: true, canDeleteAny: true },
    'GESTOR':   { level: 3, label: 'Gestor', canManageUsers: true, canDeleteAny: true },
    'USER':     { level: 2, label: 'Analista/Operador', canManageUsers: false, canDeleteAny: false },
    'TERCEIRO': { level: 1, label: 'Transportadora/Fornecedor', canManageUsers: false, canDeleteAny: false }
};

/* --- SISTEMA DE SESSÃO E INICIALIZAÇÃO (FIREBASE AUTH) --- */
firebase.auth().onAuthStateChanged(async (user) => {
    if (user) {
        try {
            let userData = null;
            let docId = null;

            // 1. Tenta pelo UID Oficial
            let userDoc = await db.collection('usuarios').doc(user.uid).get();
            if (userDoc.exists) {
                userData = userDoc.data();
                docId = userDoc.id;
            }
            
            // 2. O RADAR DE PRIVILÉGIOS (Anti-Duplicidade e Correção)
            // Se não achou pelo UID, OU se achou um documento "fantasma" sem cargo, vai procurar o seu documento original pelo E-mail!
            if (!userData || !(userData.role || userData.perfil || userData.Perfil)) {
                const snapshot = await db.collection('usuarios').where('email', '==', user.email).get();
                if (!snapshot.empty) {
                    // Varre todos os documentos com seu e-mail e prioriza resgatar o que tiver cargo MASTER
                    let bestDoc = snapshot.docs[0];
                    for (let doc of snapshot.docs) {
                        const d = doc.data();
                        const p = String(d.role || d.perfil || d.Perfil || '').toUpperCase().trim();
                        if (p === 'MASTER') { bestDoc = doc; break; }
                        if (p === 'GESTOR' && String(bestDoc.data().role || bestDoc.data().perfil).toUpperCase() !== 'MASTER') { bestDoc = doc; }
                    }
                    userData = bestDoc.data();
                    docId = bestDoc.id;
                }
            }
            
            if (!userData) {
                alert("Erro: Usuário autenticado, mas o banco de dados não o reconhece.");
                firebase.auth().signOut();
                return;
            }
            
            // 3. Captura o perfil cobrindo TODAS as variações de escrita (Maiúsculas e Minúsculas)
            const perfilBruto = userData.role || userData.perfil || userData.Perfil || userData.Role || 'USER';
            const perfilSeguro = String(perfilBruto).toUpperCase().trim();

            // 4. Monta a sessão local blindada
            CURRENT_USER = {
                email: user.email,
                name: userData.name || userData.nome || userData.Nome || 'Usuário',
                role: perfilSeguro,
                cnpjVinculado: userData.cnpjVinculado || '', 
                nomeEmpresa: userData.nomeEmpresa || '' 
            };
            CURRENT_USER.id = docId;

            // Trava extra: Verifica se o cargo realmente existe no sistema
            if (!ROLE_PERMISSIONS[CURRENT_USER.role]) {
                alert("Erro de Sistema: O perfil '" + CURRENT_USER.role + "' não está configurado.");
                firebase.auth().signOut();
                return;
            }

            // 5. Atualiza interface com o nome e cargo
            document.getElementById('user-display').innerText = CURRENT_USER.name + ' | ' + ROLE_PERMISSIONS[CURRENT_USER.role].label;
            
            // 6. TRAVA DE VISÃO DO MENU PARA TERCEIROS
            if (ROLE_PERMISSIONS[CURRENT_USER.role].level === 1) {
                document.querySelectorAll('#sidebar li, .menu-item, .module-group').forEach(el => {
                    const texto = el.innerText || el.textContent;
                    if (!texto.includes('Agendamentos') && !texto.includes('Início') && !texto.includes('Sair') && !texto.includes('Logout')) {
                        el.style.display = 'none';
                    }
                });
            }

            // 7. Inicia o painel
            goHome();
            initNotificationSystem();

        } catch (error) {
            console.error("Erro detalhado:", error);
            alert("Falha interna do sistema: " + error.message); 
        }
    } else {
        // Sem sessão, volta para a página de login
        window.location.href = 'login.html';
    }
});

function doLogout() {
    if(confirm("Deseja realmente sair do sistema?")) {
        // Agora o logout é no servidor da Google
        firebase.auth().signOut().then(() => {
            window.location.href = 'login.html';
        });
    }
}

/* --- GERENCIADOR DE DADOS (FIREBASE - NUVEM) --- */
const StorageManager = {
    // -- MÓDULO FORNECEDORES --     
    getFornecedores: async function() {
        try {
            const snapshot = await db.collection('fornecedores').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) {
            console.error("Erro ao buscar fornecedores:", e);
            return []; // Retorna lista vazia se falhar, evitando travar a tela
        }
    },
    getFornecedorById: async function(id) {
        try {
            const doc = await db.collection('fornecedores').doc(id).get();
            return doc.exists ? { id_doc: doc.id, ...doc.data() } : null;
        } catch (e) { return null; }
    },
    updateFornecedor: async function(id, forn) {
        try {
            await db.collection('fornecedores').doc(id).update(forn);
            this.logAction("EDIÇÃO", `Fornecedor atualizado: ${forn.razao}`);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao atualizar fornecedor." }; }
    },
    // --- NOVA FUNÇÃO: IMPORTAÇÃO EM LOTE (BATCH) ---
    saveFornecedoresBatch: async function(fornecedoresList) {
        try {
            // 1. DEDUPLICAÇÃO INTELIGENTE (O Segredo para evitar a quebra do Lote)
            // Se o Protheus exportar o mesmo CPF/CNPJ 2x, o sistema mantém apenas o último e evita o erro.
            const unicos = new Map();
            fornecedoresList.forEach(f => {
                if (f.cnpj) unicos.set(f.cnpj, f);
            });
            const listaFinal = Array.from(unicos.values());

            const batches = [];
            let currentBatch = db.batch();
            let count = 0;

            for (let i = 0; i < listaFinal.length; i++) {
                const forn = listaFinal[i];
                const docRef = db.collection('fornecedores').doc(forn.cnpj);
                currentBatch.set(docRef, forn, { merge: true });
                count++;

                if (count === 490) { 
                    batches.push(currentBatch);
                    currentBatch = db.batch();
                    count = 0;
                }
            }
            if (count > 0) batches.push(currentBatch);

            for (let batch of batches) {
                await batch.commit(); 
            }

            this.logAction("SISTEMA", `Importação Protheus: ${listaFinal.length} Fornecedores únicos.`);
            return { success: true, count: listaFinal.length };
        } catch (e) {
            console.error("Erro no Lote do Firebase:", e);
            return { success: false, msg: "Erro ao gravar lote na base de dados." };
        }
    },

    saveFornecedor: async function(forn) {
        try {
            // O CNPJ limpo será o ID do documento
            const docRef = db.collection('fornecedores').doc(forn.cnpj);
            await docRef.set(forn, { merge: true }); // Merge cria se não existir, atualiza se existir
            this.logAction("SISTEMA", `Fornecedor avulso salvo: ${forn.razao}`);
            return { success: true };
        } catch(e) { 
            return { success: false, msg: "Erro ao salvar fornecedor avulso." }; 
        }
    },

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
    // Varre agendas de dias anteriores esquecidas e converte em No-Show
    runAutoSweep: async function() {
        try {
            const today = SYSTEM_DATE_STR;
            const appts = await this.getAppointments();
            
            // Filtra o que é de ontem para trás e ficou "pendurado"
            const pastPending = appts.filter(a => 
                a.date < today && 
                ['AGENDADO', 'ATRASADO', 'CHEGOU', 'EM DESCARGA'].includes(a.status)
            );

            if(pastPending.length > 0) {
                const batch = db.batch();
                const nowIso = new Date().toISOString();
                
                pastPending.forEach(a => {
                    const ref = db.collection('agendamentos').doc(a.id_doc);
                    batch.update(ref, {
                        status: 'ANOMALIA',
                        motivoOcorrencia: 'No-Show (Sistema)',
                        statusObs: 'Baixa automática por virada de dia.',
                        statusUpdatedAt: nowIso,
                        statusUpdatedBy: 'Robô EletraLog',
                        anomaliaCriadaPor: 'Robô EletraLog',  // Para o Diário de Bordo
                        anomaliaCriadaEm: nowIso              // Para o Diário de Bordo
                    });
                });
                await batch.commit();
                this.logAction("SISTEMA", `Auto-Sweep: ${pastPending.length} slots passados viraram No-Show.`);
            }
        } catch(e) { console.error("Erro no Auto-Sweep", e); }
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
        if(newAppts.length > 0) {
            const doc = newAppts[0].details ? (newAppts[0].details.poMat || newAppts[0].details.oe || 'Carga') : 'Carga';
            this.dispatchSmartNotification(`Novo agendamento registado para ${newAppts[0].date}. Doc: ${doc}`, 'STATUS', 'AGENDADO', newAppts[0].userId);
        }
    },
    cancelAppointment: async function(date, time, location, tipoFluxo = 'INBOUND') {
        const snapshot = await db.collection('agendamentos')
            .where('date', '==', date)
            .where('time', '==', time)
            .where('location', '==', location)
            .get();

        if (snapshot.empty) return { success: false, msg: "Agendamento não encontrado." };

        // Proteção: Encontra o slot exato do fluxo correto (Inbound ou Outbound)
        let doc = snapshot.docs.find(d => (d.data().tipoFluxo || 'INBOUND') === tipoFluxo);
        if(!doc) return { success: false, msg: "Slot já está livre ou pertence a outro fluxo." };

        const appt = doc.data();
        const userRole = ROLE_PERMISSIONS[CURRENT_USER.role];

        // A TRAVA MESTRA: Só quem criou OU um Gestor/Master pode apagar
        if (userRole.level === 1) return { success: false, msg: "Perfil de Terceiro: Apenas Leitura." };
        if (!userRole.canDeleteAny && appt.userId !== CURRENT_USER.id) {
            return { success: false, msg: "Acesso Negado: Apenas o criador ou um Gestor podem liberar o slot." };
        }

        await db.collection('agendamentos').doc(doc.id).delete();
        this.logAction("CANCELAMENTO", `Slot Liberado: ${date} ${time} - ${location} (${tipoFluxo}) por ${CURRENT_USER.name}`);
        return { success: true };
    },

    // Atualiza o Status Logístico do Agendamento (Monitor)
    updateAppointmentStatus: async function(id_doc, newStatus, realTime = null) {
        try {
            const docRef = db.collection('agendamentos').doc(id_doc);
            const docSnap = await docRef.get();
            if (!docSnap.exists) return { success: false };
            const appt = docSnap.data();
            
            let updatePayload = { status: newStatus };
            if (realTime) {
                if(newStatus === 'CHEGADA') updatePayload.realChegada = realTime;
                if(newStatus === 'EM DESCARGA' || newStatus === 'EM CARGA') updatePayload.realDescarga = realTime;
                if(newStatus === 'SAÍDA') updatePayload.realSaida = realTime;
            }
            await docRef.update(updatePayload);
            this.logAction("ATUALIZAÇÃO STATUS", `Agendamento ${id_doc} mudou para ${newStatus} por ${CURRENT_USER.name}`);
            
            // --- GATILHO DA NOTIFICAÇÃO DE STATUS ---
            const docName = appt.details ? (appt.details.poMat || appt.details.oe || 'Carga') : 'Carga';
            let subCat = '';
            let msg = '';
            
            if(newStatus === 'CHEGADA') { subCat = 'CHEGADA'; msg = `Veículo em fila p/ entrada. Doc: ${docName}`; }
            if(newStatus === 'EM DESCARGA' || newStatus === 'EM CARGA') { subCat = 'DESCARGA'; msg = `Veículo em operação na doca. Doc: ${docName}`; }
            if(newStatus === 'SAÍDA') { subCat = 'SAÍDA'; msg = `Operação concluída. Veículo liberado. Doc: ${docName}`; }
            
            if(subCat) { this.dispatchSmartNotification(msg, 'STATUS', subCat, appt.userId); }

            return { success: true };
        } catch(e) { console.error(e); return { success: false }; }
    },
    // Atualiza o Status de Vários Slots Agrupados de uma vez
    updateStatusBatch: async function(id_docs, newStatus, obs, motivoOcorrencia = "") {
        try {
            const batch = db.batch();
            const nowIso = new Date().toISOString();
            
            id_docs.forEach(id => {
                const ref = db.collection('agendamentos').doc(id);
                let updateData = {
                    status: newStatus,
                    statusObs: obs,
                    motivoOcorrencia: motivoOcorrencia,
                    statusUpdatedAt: nowIso,
                    statusUpdatedBy: CURRENT_USER.name
                };

                if(newStatus === 'CHEGOU') updateData.horaChegada = nowIso;
                if(newStatus === 'EM DESCARGA') updateData.horaDescarga = nowIso;
                if(newStatus === 'FINALIZADO') updateData.horaSaida = nowIso;
                
                // Grava o Diário de Bordo da Criação
                if(newStatus === 'ANOMALIA') {
                    updateData.anomaliaCriadaPor = CURRENT_USER.name;
                    updateData.anomaliaCriadaEm = nowIso;
                }

                batch.update(ref, updateData);
            });
            await batch.commit();
            this.logAction("MONITOR", `Status em lote alterado p/ ${newStatus} (${id_docs.length} slots)`);
            return { success: true };
        } catch(e) {
            console.error(e);
            return { success: false, msg: "Erro ao atualizar status em lote." };
        }
    },
    saveTratativa: async function(idsString, planoAcao, acaoAgenda, temposManuais) {
        try {
            const batch = db.batch();
            const id_docs = idsString.split(',');
            const nowIso = new Date().toISOString();
            
            const now = new Date();
            const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
            const todayStr = SYSTEM_DATE_STR;

            const docsData = [];
            for (let id of id_docs) {
                const docRef = db.collection('agendamentos').doc(id);
                const snap = await docRef.get();
                if (snap.exists) docsData.push({ id, ref: docRef, time: snap.data().time, date: snap.data().date });
            }
            docsData.sort((a, b) => a.time.localeCompare(b.time));

            docsData.forEach((doc, index) => {
                let updateData = {
                    anomaliaTratada: true,
                    planoAcao: planoAcao,
                    anomaliaTratadaPor: CURRENT_USER.name, // Assinatura Diário de Bordo
                    anomaliaTratadaEm: nowIso              // Assinatura Diário de Bordo
                };

                if (acaoAgenda === 'CANCELAR') {
                    updateData.status = 'CANCELADO';
                    let isFutureSlot = (doc.date > todayStr) || (doc.date === todayStr && doc.time > currentTime);
                    if (index > 0 && isFutureSlot) batch.delete(doc.ref);
                    else batch.update(doc.ref, updateData);

                } else if (acaoAgenda === 'RESOLVER_MANUAL') {
                    updateData.status = 'FINALIZADO'; 
                    if (temposManuais.chegada) updateData.horaChegada = `${doc.date}T${temposManuais.chegada}:00`;
                    if (temposManuais.descarga) updateData.horaDescarga = `${doc.date}T${temposManuais.descarga}:00`;
                    if (temposManuais.saida) updateData.horaSaida = `${doc.date}T${temposManuais.saida}:00`;
                    batch.update(doc.ref, updateData);

                } else {
                    updateData.status = 'RESOLVIDO'; // MANTER
                    batch.update(doc.ref, updateData);
                }
            });

            await batch.commit();
            this.logAction("OCORRÊNCIA", `Tratativa (${acaoAgenda}) p/ lote ${id_docs.length} slots`);
            return { success: true };
        } catch(e) {
            console.error(e);
            return { success: false, msg: "Erro ao salvar tratativa." };
        }
    },
    saveUser: async function(userData, password) {
        try {
            // Garante que o canal secundário existe. Se não existir, ele cria na hora.
            let secondaryApp;
            try {
                secondaryApp = firebase.app("Secondary");
            } catch (err) {
                secondaryApp = firebase.initializeApp(firebase.app().options, "Secondary");
            }
            
            // 1. Cria a conta no Auth e captura a credencial
            const userCredential = await secondaryApp.auth().createUserWithEmailAndPassword(userData.email, password);
            
            // 2. Extrai o UID oficial gerado pelo Firebase Auth
            const novoUid = userCredential.user.uid;
            
            // 3. Usa o UID como NOME DO DOCUMENTO (.doc) no Firestore
            await db.collection('usuarios').doc(novoUid).set(userData);
            
            // Desloga apenas o app secundário para não derrubar o Gestor que está criando a conta
            secondaryApp.auth().signOut();
            this.logAction("SISTEMA", `Novo utilizador criado: ${userData.email} (UID: ${novoUid})`);
            return { success: true };
        } catch(e) { 
            console.error("Erro na criação do usuário:", e);
            return { success: false, msg: "Erro: " + e.message }; 
        }
    },

    dispatchSmartNotification: async function(message, type, subCategory, creatorId = null) {
        try {
            const batch = db.batch();
            const now = new Date().toISOString();
            let targets = new Set();
            
            if (creatorId) targets.add(creatorId); // Regra 1: Pai da criança

            const usersSnap = await db.collection('usuarios').get();
            usersSnap.forEach(doc => {
                const u = doc.data();
                const role = String(u.role || u.perfil).toUpperCase();
                
                if (role === 'MASTER') {
                    targets.add(doc.id); // Master vê tudo (Visão 360)
                } else if (role === 'GESTOR' || role === 'USER') {
                    const areas = u.areas || [];
                    
                    // ROTEAMENTO POR STATUS DE DOCA
                    if (type === 'STATUS') {
                        if (subCategory === 'AGENDADO' && (areas.includes('Portaria') || areas.includes('Fiscal'))) targets.add(doc.id);
                        if (subCategory === 'CHEGADA' && (areas.includes('Recebimento') || areas.includes('Fiscal'))) targets.add(doc.id);
                        if (subCategory === 'DESCARGA' && (areas.includes('Portaria') || areas.includes('Fiscal') || areas.includes('Recebimento') || areas.includes('Plan Demanda'))) targets.add(doc.id);
                        if (subCategory === 'SAÍDA' && (areas.includes('Fiscal') || areas.includes('Portaria') || areas.includes('Recebimento'))) targets.add(doc.id);
                    }
                    // ROTEAMENTO DE ANOMALIAS
                    else if (type === 'ANOMALIA') {
                        if (subCategory === 'EXTERNALIDADE' && (areas.includes('Compras') || areas.includes('Comex') || areas.includes('Fretes') || areas.includes('Recebimento') || areas.includes('Plan Demanda'))) targets.add(doc.id);
                        if (subCategory === 'FISCAL' && (areas.includes('Fiscal') || areas.includes('Plan Demanda') || areas.includes('Compras') || areas.includes('Comex') || areas.includes('Recebimento'))) targets.add(doc.id);
                        if (subCategory === 'OPERACIONAL' && (areas.includes('Compras') || areas.includes('Comex') || areas.includes('Fiscal') || areas.includes('Portaria') || areas.includes('Plan Demanda'))) targets.add(doc.id);
                        if (subCategory === 'CRITICA') targets.add(doc.id); // Broadcast total
                    }
                    // ROTEAMENTO FINANCEIRO (ADITIVOS)
                    else if (type === 'FINANCEIRO') {
                        if (areas.includes('Fretes') || areas.includes('Compras') || areas.includes('Monitoramento')) targets.add(doc.id);
                    }
                    // ROTEAMENTO DO MURAL DE FRETES (Apenas a equipe que decide o BID)
                    else if (type === 'BID_INTERNO') {
                        if (areas.includes('Fretes') || areas.includes('Compras')) targets.add(doc.id);
                    }
                } 
                // REGRA 4: TERCEIROS (O Chamamento para o Mural)
                else if (role === 'TERCEIRO') {
                    if (type === 'BID_MURAL') targets.add(doc.id);
                }
            });

            targets.forEach(userId => {
                const ref = db.collection('notificacoes').doc();
                batch.set(ref, { userId: userId, message: message, read: false, timestamp: now, type: type });
            });
            await batch.commit();

            targets.forEach(userId => {
                const ref = db.collection('notificacoes').doc();
                batch.set(ref, { userId: userId, message: message, read: false, timestamp: now, type: type });
            });
            await batch.commit();
        } catch(e) { console.error("Erro no roteamento inteligente:", e); }
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

    // --- MÓDULO ITINERÁRIOS ---
    getItinerarios: async function() {
        try {
            const snapshot = await db.collection('itinerarios').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    saveItinerario: async function(itinerario) {
        try {
            // O ID será uma mescla da Origem com o último Destino (CEP) para facilitar busca do roteirizador
            await db.collection('itinerarios').doc(itinerario.rotaId).set(itinerario, { merge: true });
            this.logAction("ROTEIRIZAÇÃO", `Nova Rota Consolidada: ${itinerario.rotaId}`);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao salvar itinerário." }; }
    },

    // --- MÓDULO TABELAS DE FRETE ---
    getTabelasFrete: async function() {
        try {
            const snapshot = await db.collection('tabelas_frete').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    saveTabelaFrete: async function(tabela) {
        try {
            await db.collection('tabelas_frete').add(tabela);
            this.logAction("COMERCIAL", `Nova Tabela de Frete: ${tabela.transportadora} p/ Região ${tabela.regiaoDestino}`);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao salvar tabela de frete." }; }
    },
    // --- MÓDULO VIAGENS ---
    getViagens: async function() {
        try {
            const snapshot = await db.collection('viagens').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    saveViagem: async function(viagem) {
        try {
            await db.collection('viagens').add(viagem);
            this.logAction("VIAGEM", `Nova viagem iniciada: OE ${viagem.oe}`);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao salvar viagem." }; }
    },
    updateViagemStatus: async function(id_doc, novoStatus) {
        try {
            await db.collection('viagens').doc(id_doc).update({ statusTracking: novoStatus, dataUltimoStatus: new Date().toISOString() });
            this.logAction("TRACKING", `OE atualizada para: ${novoStatus}`);
            return { success: true };
        } catch(e) { return { success: false }; }
    },

    // --- MÓDULO ADITIVOS (DESPESAS EXTRAS) ---
    getAditivos: async function() {
        try {
            const snapshot = await db.collection('aditivos').get();
            return snapshot.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
        } catch (e) { return []; }
    },
    saveAditivo: async function(aditivo) {
        try {
            await db.collection('aditivos').add(aditivo);
            this.logAction("FINANCEIRO", `Solicitação de Aditivo gerada para OE: ${aditivo.oe}`);
            return { success: true };
        } catch(e) { return { success: false, msg: "Erro ao gerar aditivo." }; }
    },
    updateAditivoTratativa: async function(id_doc, status, justificativaGestor) {
        try {
            await db.collection('aditivos').doc(id_doc).update({
                status: status,
                justificativaAprovacao: justificativaGestor,
                avaliadoPor: CURRENT_USER.name,
                dataAvaliacao: new Date().toISOString()
            });
            this.logAction("FINANCEIRO", `Aditivo ${status} por ${CURRENT_USER.name}`);
            return { success: true };
        } catch(e) { return { success: false }; }
    },
    clearData: async function() {
        alert("Limpeza global desativada na versão online por segurança.");
    }
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
    document.getElementById('view-title').innerText = "Dashboard Principal";
    document.getElementById('view-breadcrumb').innerText = "Sistemas Eletra Energy";

    // TELA EXCLUSIVA E LIMPA PARA TERCEIROS (Sem gráficos e sem log de eventos Eletra)
    if (ROLE_PERMISSIONS[CURRENT_USER.role].level === 1) {
        document.getElementById('workspace').innerHTML = `
            <div class="card" style="text-align:center; padding: 50px 20px; border-color:var(--eletra-aqua);">
                <h2 style="color:var(--eletra-aqua); margin-bottom:15px;"><i class="fa-solid fa-truck-fast"></i> Portal do Transportador</h2>
                <p style="color:#aaa; margin-bottom: 30px;">Bem-vindo, ${CURRENT_USER.name}. Utilize este portal para solicitar os seus agendamentos de entrega (Inbound).</p>
                <button class="mark-btn action apply" style="border-color:var(--eletra-aqua); color:var(--eletra-aqua); padding: 10px 20px;" onclick="loadPage('Agendamentos')">ACESSAR AGENDAMENTOS</button>
            </div>
        `;
        const sidebar = document.getElementById('sidebar');
        if (sidebar && sidebar.classList.contains('active')) sidebar.classList.remove('active');
        return; // Retorna aqui para não carregar os painéis abaixo
    }

    await StorageManager.runAutoSweep();
    const appts = await StorageManager.getAppointments();
    const count = appts.length;
    
    document.getElementById('workspace').innerHTML = `
        <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:15px;">
                <div>
                    <h3 style="color: white; margin-bottom: 15px;">Bem-vindo, ${CURRENT_USER.name.split(' ')[0]}</h3>
                    <div class="marking-group">
                        <button class="mark-btn selected">Agendamentos Ativos: ${count}</button>
                    </div>
                </div>
                <div style="background:#1a1d21; padding:15px; border-radius:4px; border:1px solid var(--border-color); display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <input type="date" id="home-date" value="${SYSTEM_DATE_STR}" onchange="updateHomeLog()" style="background:#0b0e11; color:white; border:1px solid #444; padding:6px; border-radius:3px;">
                    <select id="home-loc" onchange="updateHomeLog()" style="background:#0b0e11; color:white; border:1px solid #444; padding:6px; border-radius:3px;">
                        <option value="Doca">Doca</option>
                        <option value="Portaria">Portaria</option>
                    </select>
                    <button class="mark-btn action apply" onclick="printDailySchedule()" style="border-color:var(--eletra-aqua); color:var(--eletra-aqua);"><i class="fa-solid fa-print"></i> IMPRIMIR AGENDA</button>
                </div>
            </div>
        </div>
        
        <div class="card" style="padding:0; overflow:hidden;">
            <div style="padding: 15px; background: #1a1d21; border-bottom: 1px solid var(--border-color);">
                <h4 style="color: var(--eletra-orange);"><i class="fa-solid fa-list-check"></i> Agenda Vigente e Eventos</h4>
            </div>
            <div id="log-content" style="padding: 20px; overflow-y:auto;">Carregando painel de eventos...</div>
        </div>
    `;

    document.querySelectorAll('.module-group').forEach(g => g.classList.remove('active'));
    
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('active')) {
        sidebar.classList.remove('active');
    }

    updateHomeLog();
}

window.updateHomeLog = function() {
    const d = document.getElementById('home-date').value;
    const l = document.getElementById('home-loc').value;
    if(typeof updateLogPanel === 'function') updateLogPanel(d, l);
}

function loadPage(page, module) {
    const workspace = document.getElementById('workspace');
    document.getElementById('view-title').innerText = page;
    document.getElementById('view-breadcrumb').innerText = module + " > " + page;

    if (page === 'Transportadora') { renderTransportadora(workspace); }
    else if (page === 'Equipamento') { renderEquipamento(workspace); }
    else if (page === 'Cliente') { renderCliente(workspace); }
    else if (page === 'Produto') { renderProduto(workspace); }
    else if (page === 'Fornecedor') { renderFornecedor(workspace); }
    else if (page === 'Motorista') { renderMotorista(workspace); }
    else if (page === 'Itinerários') { renderItinerarios(workspace); }
    else if (page === 'Tabelas de Frete') { renderTabelasFrete(workspace); }
    else if (page === 'Roteirizador') { renderRoteirizador(workspace); }
    else if (page === 'Viagens') { renderViagens(workspace); }
    else if (page === 'Agendamentos') { renderAgendamentos(workspace); }
    else if (page === 'Aditivos') { renderAditivos(workspace); }
    else if (page === 'Monitor') { renderMonitor(workspace); }
    else if (page === 'Ocorrências') { renderOcorrencias(workspace); }
    else if (page === 'Diário de bordo') { renderDiarioDeBordo(workspace); }
    else if (page === 'Logs do Sistema') { renderLogsPage(workspace); }
    else if (page === 'Inbound OTD') { renderInboundOTD(workspace); }
    else if (page === 'Inbound Efetividade') { renderInboundEfetividade(workspace); }
    else if (page === 'Inbound Lead Times') { renderInboundLeadTimes(workspace); }
    else if (page === 'Mural de Fretes') { renderBidSpot(workspace); }
    else if (page === 'Próprio') { renderProprio(workspace); }
    else if (page === 'Terceiro') { renderTerceiro(workspace); }
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
    let rows = transps.map(t => {
        let badgeContrato = t.possuiContrato === 'SIM' 
            ? `<span style="font-size:0.6rem; background:var(--eletra-aqua); color:var(--bg-petroleo); padding:2px 4px; border-radius:3px; font-weight:bold; margin-top:4px; display:inline-block;"><i class="fa-solid fa-file-signature"></i> CONTRATADA</span>` 
            : `<span style="font-size:0.6rem; background:#333; color:#888; border:1px solid #555; padding:2px 4px; border-radius:3px; margin-top:4px; display:inline-block;">FRETE SPOT</span>`;
        return `
        <tr style="border-bottom:1px solid #333;">
            <td style="padding:10px;">${t.cnpj}</td>
            <td><strong>${t.razao}</strong><br><span style="font-size:0.7rem; color:#888;">${t.fantasia || ''}</span><br>${badgeContrato}</td>
            <td>${t.contatoNome}<br><span style="font-size:0.7rem;">${t.contatoTel}</span></td>
            <td>${t.rntrcValidade}<br><span style="font-size:0.7rem; color:${new Date(t.rntrcValidade) < new Date() ? '#FF3131' : '#00D4FF'}">RNTRC</span></td>
            <td style="font-size:0.7rem;">RCTR-C: ${t.seguros?.rctrc?.seguradora || '-'}<br>Frota: ${t.frotaPropriaPct || '0'}%</td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px 10px; margin-right:5px;" onclick="handleEditTransportadora('${t.id_doc}')" title="Editar"><i class="fa-solid fa-pencil"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 10px;" onclick="handleDeleteTransportadora('${t.id_doc}')" title="Apagar"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
        `;
    }).join('');

    if (transps.length === 0) rows = `<tr><td colspan="6" style="text-align:center; padding:15px; font-style:italic;">Nenhuma parceira cadastrada.</td></tr>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" id="tab-geral-btn" onclick="switchTab('geral')">Geral / Seguros / Operacional</button>
                <button class="tab-btn" onclick="switchTab('lista-transp')" style="color:var(--eletra-orange)">Cadastradas (${transps.length})</button>
            </div>
            
            <div id="geral" class="tab-content active" style="position:relative;">
                <div id="status-card" class="status-neon" style="display:none;"></div>
                <input type="hidden" id="t-id-doc">
                <div class="form-row"><label>CNPJ / CPF*:</label><input type="text" id="t-cnpj" list="lista-fornecedores-cnpj" placeholder="Digite os números" oninput="applyCpfCnpjMask(this); autoFillTransp(this, 'cnpj')" maxlength="18"></div>
                <div class="form-row"><label>Razão Social*:</label><input type="text" id="t-razao" list="lista-fornecedores-nome" placeholder="Nome oficial na Receita Federal" oninput="autoFillTransp(this, 'nome')"></div>
                <div class="form-row"><label>Nome Fantasia:</label><input type="text" id="t-fantasia" placeholder="Nome comercial"></div>
                <div class="form-row">
                    <label style="color:var(--eletra-aqua); font-weight:bold;"><i class="fa-solid fa-file-contract"></i> Status Comercial:</label>
                    <select id="t-contrato" style="width: 50%; padding: 5px; background: #0B0E11; color: white; border: 1px solid var(--eletra-aqua); border-radius: 3px;">
                        <option value="NÃO">NÃO (Frete Spot / Avulso)</option>
                        <option value="SIM">SIM (Contrato Firmado / Tabela Target)</option>
                    </select>
                </div>
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
    
    if(typeof carregarDropdownFornecedores === 'function') carregarDropdownFornecedores();
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
            status.style.display = 'block';
            status.innerText = "ATENÇÃO: DOC VENCIDO"; 
            status.className = "status-neon inactive"; 
        } else { 
            if (status.innerText.includes("EDIÇÃO")) {
                status.style.display = 'block';
                status.className = "status-neon active"; 
            } else {
                status.style.display = 'none';
            }
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
        possuiContrato: document.getElementById('t-contrato').value,
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
                <div id="eq-status-card" class="status-neon" style="display:none;"></div>
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
                <button class="mark-btn action" onclick="abrirImportadorClientes()">IMPORTAR CLIENTES</button>
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
                            <input type="text" id="c-cep" placeholder="00000-000" oninput="applyCepMask(this)" onblur="buscaCepCliente()" maxlength="9">
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
    document.getElementById('eq-status-card').style.display = "block";
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
    applyCpfCnpjMask(document.getElementById('t-cnpj'));
    document.getElementById('t-razao').value = t.razao;
    document.getElementById('t-fantasia').value = t.fantasia || '';
    document.getElementById('t-contrato').value = t.possuiContrato || 'NÃO';
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

    document.getElementById('status-card').style.display = 'block';
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
                <div id="cli-status-card" class="status-neon" style="display:none;"></div>
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

    document.getElementById('cli-status-card').style.display = "block";
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
                <div id="mot-status-card" class="status-neon" style="display:none;"></div>
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
        statusCard.style.display = 'block';
        statusCard.innerText = "ATENÇÃO: CNH VENCIDA"; 
        statusCard.className = "status-neon inactive";
    } else {
        validadeEl.classList.remove('input-error');
        if (statusCard.innerText.includes("EDIÇÃO")) {
            statusCard.style.display = 'block';
            statusCard.className = "status-neon active";
        } else {
            statusCard.style.display = 'none';
        }
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

    document.getElementById('mot-status-card').style.display = 'block';
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
/* --- MÓDULO DE AGENDAMENTOS E ORDENS DE EMBARQUE --- */
let selectedSlots = [];
let selectedOutboundSlots = [];

function renderAgendamentos(container) {
    const isTerceiro = (ROLE_PERMISSIONS[CURRENT_USER.role].level === 1);    
    container.innerHTML = `
        <div class="props-container">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('inbound'); updateInboundSlots()">Recebimento (Inbound)</button>
                ${!isTerceiro ? `<button class="tab-btn" onclick="switchTab('outbound'); updateOutboundSlots()">Expedição (Outbound)</button>` : ''}
            </div>
            
            <div id="inbound" class="tab-content active">
                <fieldset class="prop-group">
                    <legend>Check-in (Inbound)</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">Pedido Compra (Mat)*:</label><input type="text" id="input-po-mat"></div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">NF Material*:</label><input type="text" id="input-nf"></div>
                            <div class="form-row"><label>CNPJ/CPF Fornec.:</label><input type="text" id="input-cnpj-fornecedor" list="lista-fornecedores-cnpj" oninput="applyCpfCnpjMask(this); autoFillFornecedor(this, 'cnpj')" placeholder="00.000.000/0000-00" maxlength="18"></div>
                            <div class="form-row"><label>Fornecedor:</label><input type="text" id="input-fornecedor" list="lista-fornecedores-nome" oninput="autoFillFornecedor(this, 'nome')" placeholder="Digite o nome (Livre)"></div>
                            <div class="form-row"><label>Solicitante:</label><input type="text" id="input-solicitante"></div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">Comprador*:</label><input type="text" id="input-comprador"></div>
                        </div>
                        <div>
                            <div class="form-row"><label>CNPJ/CPF Transp.:</label><input type="text" id="input-cnpj-transp" list="lista-transportadoras-cnpj" oninput="applyCpfCnpjMask(this); autoFillTransportadora(this, 'cnpj')" placeholder="00.000.000/0000-00" maxlength="18" ${isTerceiro && CURRENT_USER.cnpjVinculado ? `value="${CURRENT_USER.cnpjVinculado}" readonly style="background:#333;"` : ''}></div>
                            <div class="form-row"><label>Transportadora:</label><input type="text" id="input-transp" list="lista-transportadoras-nome" oninput="autoFillTransportadora(this, 'nome')" placeholder="Nome ou Avulso/Correios" ${isTerceiro && CURRENT_USER.nomeEmpresa ? `value="${CURRENT_USER.nomeEmpresa}" readonly style="background:#333;"` : ''}></div>
                            <div class="form-row"><label style="color:var(--eletra-aqua)">Pedido Frete*:</label><input type="text" id="input-po-frete" placeholder="Ou CIF"></div>
                            <div class="form-row"><label>CTRC:</label><input type="text" id="input-ctrc"></div>
                            <div class="form-row"><label>Tipo Veículo:</label>
                                <select id="input-tipo-veiculo">
                                    <option value="">Selecione...</option><option value="Moto">Moto</option><option value="Passeio">Passeio</option><option value="Utilitário">Utilitário</option><option value="VUC">VUC / 3/4</option><option value="Toco">Toco</option><option value="Truck">Truck</option><option value="Carreta">Carreta</option>
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
                    <div class="slot-grid" id="inbound-slots" style="padding-bottom: 20px;"></div>
                </fieldset>
                <div class="props-footer" style="padding-top:10px;">
                    ${!isTerceiro ? `<button class="mark-btn action" style="border-color:#FF3131; color:#FF3131;" onclick="handleLiberar()">LIBERAR SLOTS</button>` : ''}
                    <button class="mark-btn action apply" onclick="saveBooking()">SALVAR AGENDAMENTO</button>
                </div>
            </div>

            ${!isTerceiro ? `
            <div id="outbound" class="tab-content">
                <fieldset class="prop-group">
                    <legend>Ordem de Embarque (Outbound)</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div>
                            <div class="form-row"><label style="color:#FF8200">Ordem de Embarque (O.E.)*:</label><input type="text" id="out-oe"></div>
                            <div class="form-row"><label style="color:#FF8200">NF Venda (Saída)*:</label><input type="text" id="out-nf"></div>
                            <div class="form-row"><label style="color:#39FF14">Valor da Carga (R$)*:</label><input type="number" id="out-valor" placeholder="150000.00" step="0.01"></div>
                            <div class="form-row"><label>Destino / Cliente:</label><input type="text" id="out-cliente" list="lista-clientes-outbound" oninput="autoFillClienteOutbound(this)" placeholder="Digite a Razão Social"></div>
                            <div class="form-row"><label style="color:var(--eletra-aqua);">UF Destino*:</label><input type="text" id="out-uf" maxlength="2" placeholder="Preenchimento Automático" readonly style="background:#333; cursor:not-allowed;"></div>
                        </div>
                        <div>
                            <div class="form-row"><label>CNPJ Transp.:</label><input type="text" id="out-cnpj-transp" oninput="applyCpfCnpjMask(this)"></div>
                            <div class="form-row"><label>Transportadora / Motorista:</label><input type="text" id="out-transp" placeholder="Nome da Transportadora"></div>
                            <div class="form-row"><label>Placa do Veículo:</label><input type="text" id="out-placa"></div>
                            <div class="form-row"><label>Tipo Veículo:</label>
                                <select id="out-veiculo">
                                    <option value="">Selecione...</option><option value="VUC / 3/4">VUC / 3/4</option><option value="Toco">Toco</option><option value="Truck">Truck</option><option value="Bitruck">Bitruck</option><option value="Carreta">Carreta</option><option value="Fração">Fracionado</option>
                                </select>
                            </div>
                            <div class="form-row"><label>Observações:</label><input type="text" id="out-obs" placeholder="Instruções..."></div>
                        </div>
                    </div>
                </fieldset>
                <fieldset class="prop-group">
                    <legend>Alocação de Expedição</legend>
                    <div class="form-row"><label>Doca / Pátio:</label><select id="out-loc" onchange="updateOutboundSlots()"><option value="Expedição Doca 1">Expedição Doca 1</option><option value="Expedição Doca 2">Expedição Doca 2</option><option value="Pátio Externo">Pátio Externo</option></select></div>
                    <div class="form-row"><label>Data Coleta:</label><input type="date" id="out-date" value="${SYSTEM_DATE_STR}" onchange="updateOutboundSlots()"></div>
                    <div class="slot-grid" id="outbound-slots" style="padding-bottom: 20px;"></div>
                </fieldset>
                <div class="props-footer" style="padding-top:10px;">
                    <button class="mark-btn action" style="border-color:#FF3131; color:#FF3131;" onclick="handleLiberarOutbound()">LIBERAR SLOTS</button>
                    <button class="mark-btn action apply" style="border-color:#FF8200; color:#FF8200;" onclick="saveOutboundBooking()">SALVAR O.E.</button>
                </div>
            </div>
            ` : ''}
        </div>`;
    
    if(typeof carregarDropdownFornecedores === 'function') carregarDropdownFornecedores();
    if(typeof carregarDropdownTransportadoras === 'function') carregarDropdownTransportadoras();
    if(typeof carregarDropdownClientes === 'function') carregarDropdownClientes();
    updateInboundSlots();
}

// ---------------- LÓGICA DO GRID (PRIVACIDADE INCLUÍDA) ---------------- //
async function updateGridSlots(gridId, dateId, locId, filterTipoFluxo, selectionArray) {
    const grid = document.getElementById(gridId);
    if(!grid) return;
    
    grid.innerHTML = '<div style="color:white; padding:20px; text-align:center;">Carregando agenda...</div>';
    
    // Limpa a seleção atual passando array por referência
    selectionArray.length = 0; 
    
    const date = document.getElementById(dateId).value;
    const location = document.getElementById(locId).value;
    const isTerceiro = ROLE_PERMISSIONS[CURRENT_USER.role].level === 1;
    const isGestor = ROLE_PERMISSIONS[CURRENT_USER.role].canDeleteAny;
    
    const allAppts = await StorageManager.getAppointments();
    const occupiedSlots = allAppts.filter(a => a.date === date && a.location === location && (a.tipoFluxo || 'INBOUND') === filterTipoFluxo);

    let html = '';
    for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 10) {
            let time = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
            const booking = occupiedSlots.find(b => b.time === time);
            
            let className = '';
            let clickAction = '';
            let tooltip = 'Livre';

            if (booking) {
                // Reconhece se é o próprio utilizador ou se a carga pertence ao mesmo CNPJ vinculado à transportadora
                const isSameCompany = (booking.userId === CURRENT_USER.id) || 
                                      (isTerceiro && CURRENT_USER.cnpjVinculado && booking.details.cnpjTransp === CURRENT_USER.cnpjVinculado);

                if (isSameCompany) {
                    // Carga pertencente à mesma Transportadora
                    className = 'my-booking'; 
                    clickAction = `toggleSlot(this, '${time}', ${gridId === 'inbound-slots' ? 'selectedSlots' : 'selectedOutboundSlots'})`;
                    tooltip = `Minha Carga: ${booking.details.poMat || booking.details.oe || ''}`;
                } else {
                    // Ocupado por terceiros ou outros setores
                    className = 'occupied-by-others';
                    
                    if (isTerceiro) {
                        // PRIVACIDADE MÁXIMA: Terceiro só vê "Ocupado"
                        tooltip = `Horário Ocupado`;
                        clickAction = ''; 
                    } else if (isGestor) {
                        // GESTOR: Pode apagar e ver tudo
                        clickAction = `toggleSlot(this, '${time}', ${gridId === 'inbound-slots' ? 'selectedSlots' : 'selectedOutboundSlots'})`;
                        tooltip = `Ocupado por: ${booking.userName} (${booking.details.poMat || booking.details.oe || '-'})`;
                    } else {
                        // USER INTERNO: Vê quem ocupou, mas não pode deletar a menos que abra a info
                        const escObs = (booking.details.obs || '').replace(/'/g, "\\'");
                        clickAction = `showBookingInfo('${booking.userName}', '${booking.details.poMat || booking.details.oe}', '${booking.details.comprador || booking.details.cliente}', '${booking.timestamp}', '${booking.details.tipoVeiculo || ''}', '${escObs}')`;
                        tooltip = `Ocupado por: ${booking.userName}`;
                    }
                }
            } else {
                if(!isTerceiro || (isTerceiro && gridId === 'inbound-slots')) {
                    // Terceiros podem clicar se for Inbound livre (se for a regra da empresa)
                    clickAction = `toggleSlot(this, '${time}', ${gridId === 'inbound-slots' ? 'selectedSlots' : 'selectedOutboundSlots'})`;
                }
            }
            html += `<div class="time-slot ${className}" title="${tooltip}" onclick="${clickAction}">${time}</div>`;
        }
    }
    grid.innerHTML = html;
}

window.updateInboundSlots = function() { updateGridSlots('inbound-slots', 'in-date', 'loc', 'INBOUND', selectedSlots); }
window.updateOutboundSlots = function() { updateGridSlots('outbound-slots', 'out-date', 'out-loc', 'OUTBOUND', selectedOutboundSlots); }

window.toggleSlot = function(el, time, targetArray) {
    if (el.classList.contains('occupied-by-others') && !ROLE_PERMISSIONS[CURRENT_USER.role].canDeleteAny) return;
    
    if (el.classList.contains('selected')) {
        el.classList.remove('selected');
        const index = targetArray.indexOf(time);
        if (index > -1) targetArray.splice(index, 1);
    } else {
        el.classList.add('selected');
        targetArray.push(time);
    }
}

// ---------------- SALVAMENTO DA ORDEM DE EMBARQUE (OUTBOUND) ---------------- //
window.saveOutboundBooking = async function() {
    const date = document.getElementById('out-date').value;
    const location = document.getElementById('out-loc').value;
    
    const oe = document.getElementById('out-oe').value.trim();
    const nf = document.getElementById('out-nf').value.trim();
    const valorNF = document.getElementById('out-valor').value.trim();
    
    const transp = document.getElementById('out-transp').value.trim();
    const cnpjTransp = document.getElementById('out-cnpj-transp').value.trim();
    const cliente = document.getElementById('out-cliente').value.trim();
    const uf = document.getElementById('out-uf').value.trim();
    
    const veiculo = document.getElementById('out-veiculo').value;
    const placa = document.getElementById('out-placa').value.trim();
    const obs = document.getElementById('out-obs').value.trim();

    if (selectedOutboundSlots.length === 0) { notify("Selecione os horários para carregamento.", "error"); return; }
    if (!oe || !nf || !valorNF) { notify("Preencha O.E., NF e Valor da Carga.", "error"); return; }

    const conflict = (await StorageManager.getAppointments()).find(a => a.date === date && a.location === location && selectedOutboundSlots.includes(a.time));
    if (conflict) { notify(`ERRO: Doca ocupada no horário ${conflict.time}.`, "error"); updateOutboundSlots(); return; }

    if (!confirm(`Confirmar Ordem de Embarque para Expedição?`)) return;
    
    const loteTimestamp = new Date().toISOString();

    const newBookings = selectedOutboundSlots.map(time => ({
        id: Date.now() + Math.random(),
        date, time, location,
        userId: CURRENT_USER.id,
        userName: CURRENT_USER.name,
        timestamp: loteTimestamp, 
        tipoFluxo: 'OUTBOUND',
        status: 'AGENDADO', // Irá para o Monitor
        details: { oe, nf, valorNF, transp, cnpjTransp, cliente, uf, tipoVeiculo: veiculo, placa, obs }
    }));

    await StorageManager.saveAppointments(newBookings);
    StorageManager.logAction("EXPEDIÇÃO", `O.E. gerada: ${oe} | Destino: ${cliente}`);
    notify("Ordem de Embarque e Alocação de Doca concluídas!", "success");
    updateOutboundSlots();
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
    if (selectedSlots.length === 0) { notify("Selecione um horário para liberar.", "error"); return; }
    if (!confirm(`Liberar ${selectedSlots.length} horários no INBOUND?`)) return;

    const date = document.getElementById('in-date').value;
    const location = document.getElementById('loc').value;
    let successCount = 0;
    
    for (const time of selectedSlots) {
        const res = await StorageManager.cancelAppointment(date, time, location, 'INBOUND');
        if(res.success) successCount++;
        else notify(res.msg, "error");
    }
    if (successCount > 0) { notify(`${successCount} slots liberados.`); updateInboundSlots(); }
}

window.handleLiberarOutbound = async function() {
    if (selectedOutboundSlots.length === 0) { notify("Selecione um horário para liberar.", "error"); return; }
    if (!confirm(`Liberar ${selectedOutboundSlots.length} horários no OUTBOUND?`)) return;

    const date = document.getElementById('out-date').value;
    const location = document.getElementById('out-loc').value;
    let successCount = 0;
    
    for (const time of selectedOutboundSlots) {
        const res = await StorageManager.cancelAppointment(date, time, location, 'OUTBOUND');
        if(res.success) successCount++;
        else notify(res.msg, "error");
    }
    if (successCount > 0) { notify(`${successCount} slots liberados.`); updateOutboundSlots(); }
}

/* --- GESTÃO DE USUÁRIOS --- */
async function renderUsersPage(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3><p>Sem permissão.</p></div>`;
        return;
    }

    container.innerHTML = '<div class="card" style="text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando usuários...</div>';
    
    // Busca os usuários no banco de dados Firestore
    const users = await StorageManager.getUsers();
    
    // Constrói as linhas da tabela - versão robusta que ignora erros individuais
    let rows = "";
    if (users && users.length > 0) {
        rows = users.map(u => {
            if (!u) return ''; 
            return `
            <tr style="border-bottom:1px solid #333;">
                <td style="padding:10px;">${u.matricula || '-'}</td>
                <td>${u.name || '-'}</td>
                <td>${u.email || '-'}</td>
                <td>${u.user || '-'}</td>
                <td><span class="badge ${u.role || 'USER'}">${u.role || 'Não definido'}</span></td>
                <td style="text-align:right;">
                    <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:2px 8px;" onclick="deleteUser('${u.id_doc}')"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>
            `;
        }).join('');
    } else {
        rows = `<tr><td colspan="6" style="text-align:center; padding:15px; font-style:italic;">Nenhum usuário encontrado na base.</td></tr>`;
    }

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px;">
            <div class="tab-content active">
                <fieldset class="prop-group">
                    <legend>Novo Usuário</legend>
                    <div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap:10px;">
                        <div class="form-row-col"><label>Matrícula</label><input type="text" id="new-mat" oninput="generateAutoPass()"></div>
                        <div class="form-row-col" style="grid-column: span 2"><label>Nome Completo*</label><input type="text" id="new-name" oninput="generateAutoPass()"></div>
                        <div class="form-row-col"><label>CPF</label><input type="text" id="new-cpf"></div>
                        
                        <div class="form-row-col"><label>E-mail corporativo*</label><input type="email" id="new-email" placeholder="nome@eletraenergy.com"></div>
                        <div class="form-row-col"><label>Telefone / Ramal</label><input type="text" id="new-tel" placeholder="(85) 90000-0000"></div>
                        
                        <div class="form-row-col"><label>Login*</label><input type="text" id="new-user"></div>
                        <div class="form-row-col"><label>Senha Gerada</label><input type="text" id="new-pass" readonly style="background:#222; color:#777;"></div>
                        
                        <div class="form-row-col" style="grid-column: span 2;"><label>Perfil de Acesso*</label>
                            <select id="new-role">
                                <option value="USER">User (Analista / Operador de Doca)</option>
                                <option value="GESTOR">Gestor (Logística / Coordenação)</option>
                                <option value="MASTER">Master (Diretoria / Admin)</option>
                                <option value="TERCEIRO">Terceiro (Portaria / Transportadora)</option>
                            </select>
                        </div>
                        <div class="form-row-col" style="grid-column: span 2; display:flex; align-items:flex-end;">
                            <button class="mark-btn action apply" onclick="createNewUser()" style="width:100%">CRIAR USUÁRIO</button>
                        </div>
                    </div>
                </fieldset>
                
                <h4 style="margin-top:20px; color:var(--eletra-aqua); border-bottom:1px solid #333; padding-bottom:5px;">Base de Usuários</h4>
                
                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Matrícula</th>
                                <th>Nome</th>
                                <th>E-mail</th>
                                <th>Login</th>
                                <th>Perfil</th>
                                <th>Ações</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
}

function generateAutoPass() {
    const mat = document.getElementById('new-mat').value.trim();
    const name = document.getElementById('new-name').value.trim();
    if (mat && name) {
        // Pega a matrícula + primeira letra de cada nome
        document.getElementById('new-pass').value = mat + name.split(' ').map(n => n[0]).join('').toUpperCase();
    }
}

async function createNewUser() {
    const matricula = document.getElementById('new-mat').value.trim();
    const name = document.getElementById('new-name').value.trim();
    const cpf = document.getElementById('new-cpf').value.trim();
    const email = document.getElementById('new-email').value.trim();
    const telefone = document.getElementById('new-tel').value.trim();
    const user = document.getElementById('new-user').value.trim();
    const pass = document.getElementById('new-pass').value.trim();
    const role = document.getElementById('new-role').value;

    if (!name || !user || !pass || !email) { notify("Nome, Login, E-mail e Senha são obrigatórios.", "error"); return; }
    if (pass.length < 6) { notify("A senha gerada deve ter pelo menos 6 caracteres.", "error"); return; }

    notify("Validando e criando acessos...", "info");

    const checkEmail = await db.collection('usuarios').where('email', '==', email).get();
    if (!checkEmail.empty) { notify("Erro: Este e-mail já possui cadastro na base.", "error"); return; }
    
    const checkUser = await db.collection('usuarios').where('user', '==', user).get();
    if (!checkUser.empty) { notify("Erro: Este login já está sendo utilizado.", "error"); return; }

    try {
        // Usa a App Secundária para criar a credencial sem deslogar você
        const secondaryApp = firebase.apps.length > 1 
                            ? firebase.app("Secondary") 
                            : firebase.initializeApp(firebase.app().options, "Secondary");
        
        await secondaryApp.auth().setPersistence(firebase.auth.Auth.Persistence.NONE);
        
        let firebaseUserId = null;
        try {
            const userCredential = await secondaryApp.auth().createUserWithEmailAndPassword(email, pass);
            // PEGA O UID VERDADEIRO GERADO PELO GOOGLE
            firebaseUserId = userCredential.user.uid; 
        } finally {
            await secondaryApp.auth().signOut(); 
        }
        
        if(!firebaseUserId) throw new Error("Falha ao obter ID seguro do Authentication.");

        const newUser = { 
            id: firebaseUserId, 
            matricula: matricula, 
            name: name, 
            cpf: cpf, 
            email: email, 
            telefone: telefone, 
            user: user, 
            pass: pass, 
            role: role, 
            timestamp: new Date().toISOString() 
        };
        
        // GRAVA A FICHA NO BANCO USANDO O UID VERDADEIRO COMO NOME DA GAVETA
        await db.collection('usuarios').doc(firebaseUserId).set(newUser);
        
        notify(`Usuário ${name} criado com sucesso e pronto para login!`, "success"); 
        
        // Limpa a tela
        document.getElementById('new-mat').value = '';
        document.getElementById('new-name').value = '';
        document.getElementById('new-cpf').value = '';
        document.getElementById('new-email').value = '';
        document.getElementById('new-tel').value = '';
        document.getElementById('new-user').value = '';
        document.getElementById('new-pass').value = '';
        
        renderUsersPage(document.getElementById('workspace')); 
        
    } catch (error) {
        console.error("Erro:", error);
        notify("Erro ao criar usuário. Verifique a consola.", "error");
    }
}

async function deleteUser(id) {
    if(!confirm("Atenção: Apenas o registro do banco de dados será apagado. A credencial de login continuará ativa no Firebase Auth. Continuar?")) return;
    const res = await StorageManager.deleteUser(id);
    if (res.success) { 
        notify("Usuário excluído do banco."); 
        renderUsersPage(document.getElementById('workspace')); 
    } else { 
        notify(res.msg, "error"); 
    }
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
            const emailBtn = `<button class="mark-btn" style="padding:2px 6px; font-size:0.6rem; border-color:var(--eletra-aqua); color:var(--eletra-aqua); margin-left:10px;" onclick="copyBookingConfirmation('${g.details.poMat}', '${g.details.nf}', '${g.details.fornecedor || g.details.transp || ''}', '${date}', '${timeWindow}', 'CONFIRMAR')"><i class="fa-solid fa-envelope"></i> E-mail</button>`;
            html += `<div style="border-bottom:1px solid #333; padding:8px 0; font-size:0.75rem; display:flex; justify-content:space-between; align-items:center;">
                        <div><strong style="color:#fff;">${timeWindow}</strong> | Sol: ${g.details.solicitante||'-'} | Comp: ${g.details.comprador||'-'}${tipoDesc} | <span style="color:#888;">Agendado por: ${g.userName}</span></div>
                        <div>${emailBtn}</div>
                     </div>`;            
        });
    }
    
    const allLogs = await StorageManager.getLogs();
    html += `<h4 style="color:var(--eletra-orange); margin-top:15px; margin-bottom:5px; border-top:1px solid #444; font-size:0.75rem;">Últimos Eventos do Sistema</h4>`;
    allLogs.forEach(l => {
        html += `<div style="border-bottom:1px solid #333; padding:2px 0; font-family:monospace; font-size:0.65rem;"><span style="color:#666;">[${new Date(l.timestamp).toLocaleString('pt-BR')}]</span> <span style="color:${l.action.includes('CANCEL')?'#FF3131':'#00D4FF'}">${l.action}</span> ${l.user}: ${l.details}</div>`;
    });
    div.innerHTML = html;
}

/* --- MÓDULO MONITORAMENTO (TORRE DE CONTROLE - SEPARADA INBOUND/OUTBOUND) --- */
async function renderMonitor(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando Torre de Controle...</div>';
    
    const filterDate = window.currentMonitorDate || SYSTEM_DATE_STR;
    window.currentMonitorDate = filterDate; 

    const allAppts = await StorageManager.getAppointments();
    const dailyAppts = allAppts.filter(a => a.date === filterDate).sort((a, b) => a.time.localeCompare(b.time));
    
    // 1. SEPARAÇÃO ESTRITA DE FLUXOS
    // Se não tiver tipoFluxo, assume INBOUND (Proteção para dados antigos em produção)
    const inboundAppts = dailyAppts.filter(a => a.tipoFluxo === 'INBOUND' || !a.tipoFluxo);
    const outboundAppts = dailyAppts.filter(a => a.tipoFluxo === 'OUTBOUND');

    const calcRealEnd = (timeStr) => {
        let [h, m] = timeStr.split(':').map(Number);
        m += 10; if (m >= 60) { h++; m -= 60; }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    // ---------------------------------------------------------
    // 2. PROCESSAMENTO INBOUND (RECEPÇÃO) - MANTIDO 100% INTACTO
    // ---------------------------------------------------------
    const groupedIn = {};
    inboundAppts.forEach(a => {
        const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`;
        if(!groupedIn[key]) {
            groupedIn[key] = {
                ids: [], timeStart: a.time, timeEnd: a.time, details: a.details,
                location: a.location, userName: a.userName, status: a.status || 'AGENDADO',
                statusObs: a.statusObs || '', motivoOcorrencia: a.motivoOcorrencia || ''
            };
        }
        groupedIn[key].ids.push(a.id_doc);
        if (a.time < groupedIn[key].timeStart) groupedIn[key].timeStart = a.time;
        if (a.time > groupedIn[key].timeEnd) groupedIn[key].timeEnd = a.time;
    });

    let countIn = { agendado: 0, patio: 0, fim: 0, ocorrencia: 0 };
    let rowsIn = Object.values(groupedIn).map(g => {
        let status = g.status || 'AGENDADO';
        const realEndTime = calcRealEnd(g.timeEnd);
        
        if (status === 'AGENDADO') {
            if (filterDate < SYSTEM_DATE_STR) status = 'ATRASADO';
            else if (filterDate === SYSTEM_DATE_STR) {
                const now = new Date();
                const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                if (realEndTime < currentTime) status = 'ATRASADO';
            }
        }

        let statusColor = '#aaa';
        if (status === 'AGENDADO') { countIn.agendado++; statusColor = 'var(--eletra-aqua)'; }
        else if (status === 'CHEGOU' || status === 'EM DESCARGA') { countIn.patio++; statusColor = 'var(--eletra-orange)'; }
        else if (status === 'FINALIZADO') { countIn.fim++; statusColor = '#39FF14'; }
        else if (status === 'ATRASADO' || status === 'ANOMALIA') { countIn.ocorrencia++; statusColor = '#FF3131'; }

        let timeWindow = `${g.timeStart} às ${realEndTime}`;
        let idsString = g.ids.join(',');

        return `
        <tr style="border-bottom:1px solid #333; text-align:center;">
            <td style="padding:10px; font-weight:bold; color:var(--eletra-aqua); font-size:1.1rem; white-space:nowrap;">${timeWindow}</td>
            <td>
                <span style="font-weight:bold; color:white;">${g.details.fornecedor || 'Não Informado'}</span><br>
                <span style="font-size:0.7rem; color:#888;">PO: ${g.details.poMat} | NF: ${g.details.nf}</span>
            </td>
            <td>
                <span style="font-weight:bold; color:var(--eletra-orange);">${g.details.transp || 'Não Informada'}</span><br>
                <span style="font-size:0.7rem; color:#888;">Veículo: ${g.details.tipoVeiculo || '-'}</span>
            </td>
            <td style="font-size: 0.75rem; color: #ddd; max-width: 150px; text-align: left;">
                ${g.details.obs ? g.details.obs : '<span style="color:#555; font-style:italic;">Sem observações</span>'}
            </td>
            <td>${g.location}</td>
            <td>
                <span style="border: 1px solid ${statusColor}; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold;">${status}</span>
                ${g.motivoOcorrencia ? `<br><span style="font-size:0.65rem; color:#FF8200; margin-top:4px; display:block;">Motivo: ${g.motivoOcorrencia}</span>` : ''}
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
        </tr>`;
    }).join('');

    if (!rowsIn) rowsIn = `<tr><td colspan="7" style="text-align:center; padding:15px; font-style:italic;">Nenhum veículo de Inbound agendado para esta data.</td></tr>`;

    // ---------------------------------------------------------
    // 3. PROCESSAMENTO OUTBOUND (EXPEDIÇÃO) - NOVA ESTRUTURA
    // ---------------------------------------------------------
    const groupedOut = {};
    outboundAppts.forEach(a => {
        const key = a.timestamp || `${a.details.oe}_${a.details.nf}_${a.location}`;
        if(!groupedOut[key]) {
            groupedOut[key] = {
                ids: [], timeStart: a.time, timeEnd: a.time, details: a.details,
                location: a.location, userName: a.userName, status: a.status || 'AGENDADO',
                statusObs: a.statusObs || '', motivoOcorrencia: a.motivoOcorrencia || ''
            };
        }
        groupedOut[key].ids.push(a.id_doc);
        if (a.time < groupedOut[key].timeStart) groupedOut[key].timeStart = a.time;
        if (a.time > groupedOut[key].timeEnd) groupedOut[key].timeEnd = a.time;
    });

    let countOut = { agendado: 0, patio: 0, fim: 0, ocorrencia: 0 };
    let rowsOut = Object.values(groupedOut).map(g => {
        let status = g.status || 'AGENDADO';
        const realEndTime = calcRealEnd(g.timeEnd);
        
        if (status === 'AGENDADO') {
            if (filterDate < SYSTEM_DATE_STR) status = 'ATRASADO';
            else if (filterDate === SYSTEM_DATE_STR) {
                const now = new Date();
                const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
                if (realEndTime < currentTime) status = 'ATRASADO';
            }
        }

        let statusColor = '#aaa';
        if (status === 'AGENDADO') { countOut.agendado++; statusColor = 'var(--eletra-aqua)'; }
        else if (status === 'CHEGOU' || status === 'EM DESCARGA') { countOut.patio++; statusColor = 'var(--eletra-orange)'; }
        else if (status === 'FINALIZADO') { countOut.fim++; statusColor = '#39FF14'; }
        else if (status === 'ATRASADO' || status === 'ANOMALIA') { countOut.ocorrencia++; statusColor = '#FF3131'; }

        let timeWindow = `${g.timeStart} às ${realEndTime}`;
        let idsString = g.ids.join(',');

        return `
        <tr style="border-bottom:1px solid #333; text-align:center;">
            <td style="padding:10px; font-weight:bold; color:#FF8200; font-size:1.1rem; white-space:nowrap;">${timeWindow}</td>
            <td>
                <span style="font-weight:bold; color:white;">${g.details.cliente || 'Não Informado'}</span><br>
                <span style="font-size:0.7rem; color:#888;">UF: ${g.details.uf || '-'}</span>
            </td>
            <td>
                <span style="color:#00D4FF">O.E.: ${g.details.oe}</span><br>
                <span style="font-size:0.7rem; color:#888;">NF: ${g.details.nf} (R$ ${g.details.valorNF})</span>
            </td>
            <td>
                <span style="font-weight:bold;">${g.details.transp || 'Não Informada'}</span><br>
                <span style="font-size:0.7rem; color:#888;">${g.details.tipoVeiculo || '-'} ${g.details.placa ? `(${g.details.placa})` : ''}</span>
            </td>
            <td>${g.location}</td>
            <td>
                <span style="border: 1px solid ${statusColor}; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: bold;">${status}</span>
                ${g.motivoOcorrencia ? `<br><span style="font-size:0.65rem; color:#FF8200; margin-top:4px; display:block;">Motivo: ${g.motivoOcorrencia}</span>` : ''}
                ${g.statusObs ? `<span style="font-size:0.65rem; color:#888; margin-top:2px; display:block;">Obs: ${g.statusObs}</span>` : ''}
            </td>
            <td>
                <div style="display: flex; gap: 5px; justify-content: center; flex-wrap: wrap; width: 100%; max-width: 170px; margin: 0 auto;">
                    <button class="mark-btn" style="border-color:var(--eletra-orange); color:var(--eletra-orange); padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="quickStatusUpdate('${idsString}', 'CHEGOU')">CHEGADA</button>
                    <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="quickStatusUpdate('${idsString}', 'EM DESCARGA')">CARREG.</button>
                    <button class="mark-btn" style="border-color:#39FF14; color:#39FF14; padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="quickStatusUpdate('${idsString}', 'FINALIZADO')">SAÍDA</button>
                    <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px; font-size:0.6rem; flex: 1 1 45%;" onclick="openAnomaliaModal('${idsString}')">ANOMALIA</button>
                </div>
            </td>
        </tr>`;
    }).join('');

    if (!rowsOut) rowsOut = `<tr><td colspan="7" style="text-align:center; padding:15px; font-style:italic;">Nenhuma Ordem de Embarque (Outbound) para esta data.</td></tr>`;

    // ---------------------------------------------------------
    // 4. RENDERIZAÇÃO DA INTERFACE FINAL (Abas Independentes)
    // ---------------------------------------------------------
    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px; position:relative;">
            
            <div style="margin-bottom:15px; background:#1a1d21; padding:15px; border-radius:4px; border:1px solid var(--border-color); display:flex; align-items:center;">
                <label style="font-size:0.8rem; color:#aaa; margin-right:10px;">Monitorar Data:</label>
                <input type="date" id="monitor-date" value="${filterDate}" onblur="updateMonitorDate()" onkeydown="if(event.key === 'Enter') updateMonitorDate()" style="background:#0b0e11; color:white; border:1px solid #444; padding:5px; border-radius:3px;">
                <button class="mark-btn" style="margin-left:10px;" onclick="updateMonitorDate()"><i class="fa-solid fa-rotate-right"></i> Atualizar</button>
            </div>

            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('mon-inbound')">Monitor Inbound (Recebimento)</button>
                <button class="tab-btn" onclick="switchTab('mon-outbound')">Monitor Outbound (Expedição)</button>
            </div>

            <div id="mon-inbound" class="tab-content active">
                <div style="display:flex; gap:25px; margin-bottom:20px; justify-content:center; background:#0b0e11; padding:10px; border-radius:4px;">
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:var(--eletra-aqua);">${countIn.agendado}</div><div style="font-size:0.65rem; color:#888;">AGENDADOS</div></div>
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:var(--eletra-orange);">${countIn.patio}</div><div style="font-size:0.65rem; color:#888;">NO PÁTIO</div></div>
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:#39FF14;">${countIn.fim}</div><div style="font-size:0.65rem; color:#888;">FINALIZADOS</div></div>
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:#FF3131;">${countIn.ocorrencia}</div><div style="font-size:0.65rem; color:#888;">OCORRÊNCIAS</div></div>
                </div>

                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th style="text-align:center;">Hora</th>
                                <th style="text-align:center;">Fornecedor / PO - NF material</th>
                                <th style="text-align:center;">Transportadora / Tipo veículo</th>
                                <th style="text-align:left;">Observações</th>
                                <th style="text-align:center;">Local</th>
                                <th style="text-align:center;">Status Operacional</th>
                                <th style="text-align:center;">Ação</th>
                            </tr>
                        </thead>
                        <tbody>${rowsIn}</tbody>
                    </table>
                </div>
            </div>
            
            <div id="mon-outbound" class="tab-content">
                <div style="display:flex; gap:25px; margin-bottom:20px; justify-content:center; background:#0b0e11; padding:10px; border-radius:4px;">
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:var(--eletra-aqua);">${countOut.agendado}</div><div style="font-size:0.65rem; color:#888;">O.E. AGENDADAS</div></div>
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:var(--eletra-orange);">${countOut.patio}</div><div style="font-size:0.65rem; color:#888;">NO PÁTIO</div></div>
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:#39FF14;">${countOut.fim}</div><div style="font-size:0.65rem; color:#888;">EXPEDIDOS</div></div>
                    <div style="text-align:center;"><div style="font-size:1.4rem; font-weight:bold; color:#FF3131;">${countOut.ocorrencia}</div><div style="font-size:0.65rem; color:#888;">OCORRÊNCIAS</div></div>
                </div>

                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th style="text-align:center;">Hora</th>
                                <th style="text-align:center;">Cliente / Destino</th>
                                <th style="text-align:center;">O.E. / NF Venda</th>
                                <th style="text-align:center;">Transportadora</th>
                                <th style="text-align:center;">Doca / Pátio</th>
                                <th style="text-align:center;">Status Operacional</th>
                                <th style="text-align:center;">Ação</th>
                            </tr>
                        </thead>
                        <tbody>${rowsOut}</tbody>
                    </table>
                </div>
            </div>

            <div id="modal-backdrop" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.8); z-index:9998;"></div>
            
            <div id="status-modal" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:var(--bg-asfalto); padding:20px; border-radius:8px; border:1px solid #FF3131; z-index:9999; width:90%; max-width:400px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                <h3 style="color:#FF3131; margin-bottom:15px; border-bottom:1px solid #333; padding-bottom:10px;"><i class="fa-solid fa-triangle-exclamation"></i> Registrar Anomalia</h3>
                <input type="hidden" id="modal-id-doc">

                <div class="form-row-col" style="margin-bottom:15px;">
                    <label style="color:var(--eletra-orange)">Causa Raiz / Motivo:*</label>
                    <select id="modal-motivo" style="width:100%; padding:10px; background:#0B0E11; color:white; border:1px solid #444; border-radius:4px;">
                        <option value="">Selecione a raiz do problema...</option>
                        <option value="No-Show">No-Show</option>
                        <option value="PO/OE divergente ou ausente">PO/OE divergente ou ausente</option>
                        <option value="NF divergente ou ausente">NF divergente ou ausente</option>
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
        notify("Atenção: É obrigatório apontar a causa raiz da anomalia!", "error");
        document.getElementById('modal-motivo').focus();
        return;
    }

   const id_docs = idsString.split(',');
    
    // Identifica quem criou a agenda para mandar a notificação
    try {
        const snap = await db.collection('agendamentos').doc(id_docs[0]).get();
        if(snap.exists) {
            const ag = snap.data();
            const criadorId = ag.userId;
            const ref = ag.details.poMat || ag.details.oe || 'Documento';
        
        // Classifica a Anomalia com base no motivo selecionado
        let categoriaAnomalia = 'CRITICA';
        const exters = ["Atraso", "No-show", "Motorista sem EPI", "Veículo inadequado", "Fila por atraso"];
        const fiscais = ["PO/OE divergente", "NF divergente", "Documento divergente"];
        const opers = ["Divergência na conferência", "Carga avaria"];
        
        if (exters.includes(motivo)) categoriaAnomalia = 'EXTERNALIDADE';
        else if (fiscais.includes(motivo)) categoriaAnomalia = 'FISCAL';
        else if (opers.includes(motivo)) categoriaAnomalia = 'OPERACIONAL';

        await StorageManager.dispatchSmartNotification(`Anomalia gerada (${ref}): ${motivo}`, 'ANOMALIA', categoriaAnomalia, criadorId);
        }
    } catch(e) {}

    // Salva forçando o status para 'ANOMALIA'
    const res = await StorageManager.updateStatusBatch(id_docs, 'ANOMALIA', obs, motivo);
    
    if(res.success) {
        notify(`Anomalia registrada com sucesso!`, "error");
        closeStatusModal();
        renderMonitor(document.getElementById('workspace')); 
    } else {
        notify("Erro ao registrar anomalia.", "error");
    }
}

/* =========================================
   MÓDULO: OCORRÊNCIAS (BUCKET LIST)
   ========================================= */
async function renderOcorrencias(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Procurando anomalias na base...</div>';
    
    const allAppts = await StorageManager.getAppointments();
    const anomalias = allAppts.filter(a => a.status === 'ANOMALIA' || a.anomaliaTratada === true);
    
    const groupedAnomalias = {};
    anomalias.forEach(a => {
        const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`;
        if (!groupedAnomalias[key]) {
            groupedAnomalias[key] = {
                ids: [], timeStart: a.time, timeEnd: a.time, date: a.date, details: a.details,
                tipoFluxo: a.tipoFluxo, motivoOcorrencia: a.motivoOcorrencia, statusObs: a.statusObs,
                anomaliaTratada: a.anomaliaTratada, planoAcao: a.planoAcao,
                // Dados para o Diário de Bordo
                anomaliaCriadaPor: a.anomaliaCriadaPor || a.statusUpdatedBy || 'Sistema',
                anomaliaCriadaEm: a.anomaliaCriadaEm || a.statusUpdatedAt || a.timestamp,
                anomaliaTratadaPor: a.anomaliaTratadaPor,
                anomaliaTratadaEm: a.anomaliaTratadaEm
            };
        }
        groupedAnomalias[key].ids.push(a.id_doc);
        if (a.time < groupedAnomalias[key].timeStart) groupedAnomalias[key].timeStart = a.time;
        if (a.time > groupedAnomalias[key].timeEnd) groupedAnomalias[key].timeEnd = a.time;
        
        if (a.anomaliaTratada) {
            groupedAnomalias[key].anomaliaTratada = true;
            groupedAnomalias[key].planoAcao = a.planoAcao;
            groupedAnomalias[key].anomaliaTratadaPor = a.anomaliaTratadaPor;
            groupedAnomalias[key].anomaliaTratadaEm = a.anomaliaTratadaEm;
        }
    });

    const calcRealEnd = (timeStr) => {
        let [h, m] = timeStr.split(':').map(Number);
        m += 10; if (m >= 60) { h++; m -= 60; }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    const groupedArray = Object.values(groupedAnomalias);
    const pendentes = groupedArray.filter(g => !g.anomaliaTratada).sort((a,b) => new Date(b.date) - new Date(a.date));
    const tratadas = groupedArray.filter(g => g.anomaliaTratada).sort((a,b) => new Date(b.planoAcao.timestamp) - new Date(a.planoAcao.timestamp));

    const buildDiarioDeBordo = (g) => `
        <div style="background: rgba(255, 255, 255, 0.05); padding: 10px 15px; border-radius: 4px; border-left: 3px solid #888; margin-bottom: 15px; font-size: 0.8rem;">
            <h5 style="color: #aaa; margin-bottom: 8px; text-transform: uppercase;"><i class="fa-solid fa-clock-rotate-left"></i> Diário de Bordo (Timeline)</h5>
            <div style="margin-bottom: ${g.anomaliaTratada ? '10px' : '0'};">
                <span style="color: #FF3131;">🔴 [${new Date(g.anomaliaCriadaEm).toLocaleString('pt-BR')}]</span> Anomalia aberta por <strong>${g.anomaliaCriadaPor}</strong><br>
                <span style="color: #aaa; margin-left: 20px;">Motivo: ${g.motivoOcorrencia} ${g.statusObs ? `(${g.statusObs})` : ''}</span>
            </div>
            ${g.anomaliaTratada ? `
            <div>
                <span style="color: #39FF14;">🟢 [${new Date(g.anomaliaTratadaEm).toLocaleString('pt-BR')}]</span> Tratativa por <strong>${g.anomaliaTratadaPor}</strong><br>
                <span style="color: #aaa; margin-left: 20px;">Decisão: ${g.planoAcao.decisaoAgenda}</span>
            </div>` : ''}
        </div>
    `;

    let htmlPendentes = pendentes.map(g => {
        const timeWindow = `${g.timeStart} às ${calcRealEnd(g.timeEnd)}`;
        const idsString = g.ids.join(',');
        const elementId = g.ids[0];

        return `
        <div class="card" style="border-left: 4px solid #FF3131; padding: 15px; margin-bottom: 10px; cursor: pointer; transition: 0.2s;" onclick="toggleAnomaly('card-${elementId}')" onmouseover="this.style.background='#222'" onmouseout="this.style.background='var(--bg-asfalto)'">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <span style="background: var(--eletra-aqua); color: var(--bg-petroleo); padding: 2px 6px; border-radius: 3px; font-size: 0.65rem; font-weight: bold; margin-right: 8px;">${g.tipoFluxo || 'INBOUND'}</span>
                    <strong style="color: var(--eletra-aqua); font-size: 1.1rem;">${g.details.fornecedor || g.details.transp || 'Não Informado'}</strong>
                    <span style="font-size: 0.8rem; color: #888; margin-left: 10px;">Agendado: ${g.date.split('-').reverse().join('/')} - <strong style="color:white;">${timeWindow}</strong></span><br>
                    <span style="color: #FF3131; font-weight: bold; font-size: 0.85rem; margin-top:5px; display:inline-block;"><i class="fa-solid fa-triangle-exclamation"></i> Pendente: ${g.motivoOcorrencia}</span>
                </div>
                <div><i class="fa-solid fa-chevron-down" style="color: #aaa;"></i></div>
            </div>
            
            <div id="card-${elementId}" style="display: none; margin-top: 15px; padding-top: 15px; border-top: 1px solid #333; cursor: default;" onclick="event.stopPropagation()">
                ${buildDiarioDeBordo(g)}
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px; font-size: 0.8rem; background: #0B0E11; padding: 10px; border-radius: 4px;">
                    <div><span style="color: #888;">PO:</span> <strong>${g.details.poMat}</strong><br><span style="color: #888;">NF:</span> <strong>${g.details.nf}</strong><br><span style="color: #888;">Transp:</span> <strong>${g.details.transp || '-'}</strong></div>
                    <div><span style="color: #888;">Criado Por:</span> <strong>${g.details.criadoPor || '-'}</strong><br><span style="color: #888;">Comprador:</span> <strong>${g.details.comprador}</strong><br><span style="color: #888;">Solicitante:</span> <strong>${g.details.solicitante || '-'}</strong></div>
                </div>
                
                <div style="background: #1A1D21; padding: 15px; border-radius: 4px; border: 1px dashed #444;">
                    <h4 style="color: var(--eletra-aqua); margin-bottom: 10px; font-size: 0.85rem;"><i class="fa-solid fa-gavel"></i>Tratativa de anomalias</h4>
                    
                    <div class="form-row-col" style="margin-bottom: 10px;">
                        <label style="color:var(--eletra-orange); margin-bottom:4px;">Decisão Estratégica:*</label>
                        <select id="acao-agenda-${elementId}" style="width: 100%; padding: 8px; background: #0B0E11; color: white; border: 1px solid #444; border-radius: 4px; margin-bottom: 10px;" onchange="document.getElementById('tempos-${elementId}').style.display = this.value === 'RESOLVER_MANUAL' ? 'grid' : 'none'">
                            <option value="">Selecione o destino desta carga...</option>
                            <option value="MANTER">MANTIDA (Anomalia sanada. A operação segue viva no Monitor)</option>
                            <option value="RESOLVER_MANUAL">RESOLVIDA E FINALIZADA (Inserir tempos passados manualmente abaixo)</option>
                            <option value="CANCELAR">CANCELADA (Rejeição/No-Show. Cortar e Liberar Slots futuros)</option>
                        </select>
                    </div>

                    <div id="tempos-${elementId}" style="display: none; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 10px; background: rgba(0, 212, 255, 0.05); padding: 10px; border-radius: 4px; border: 1px solid rgba(0, 212, 255, 0.2);">
                        <div class="form-row-col"><label style="font-size:0.7rem;">Chegada Real:</label><input type="time" id="t-chegada-${elementId}" style="width:100%; padding:5px; background:#000; color:white; border:1px solid #333;"></div>
                        <div class="form-row-col"><label style="font-size:0.7rem;">Descarga Real:</label><input type="time" id="t-descarga-${elementId}" style="width:100%; padding:5px; background:#000; color:white; border:1px solid #333;"></div>
                        <div class="form-row-col"><label style="font-size:0.7rem;">Saída Real:</label><input type="time" id="t-saida-${elementId}" style="width:100%; padding:5px; background:#000; color:white; border:1px solid #333;"></div>
                    </div>

                    <div class="form-row-col" style="margin-bottom: 10px;">
                        <textarea id="acao-${elementId}" rows="2" style="width: 100%; padding: 10px; background: #0B0E11; color: white; border: 1px solid #444; border-radius: 4px; resize: none;" placeholder="Descreva a justificativa para a auditoria..."></textarea>
                    </div>
                    
                    <div style="display: flex; gap: 10px; justify-content: flex-end; align-items: center; flex-wrap: wrap;">
                        <button class="mark-btn action apply" style="font-size: 0.75rem;" onclick="confirmTratativa('${idsString}', '${elementId}')"><i class="fa-solid fa-check-double"></i> APLICAR DECISÃO</button>
                    </div>
                </div>
            </div>
        </div>
        `;
    }).join('');

    if(pendentes.length === 0) htmlPendentes = `<div style="text-align:center; padding:40px; color:#888; font-style:italic;"><i class="fa-solid fa-check-double" style="font-size:2rem; color:#39FF14; display:block; margin-bottom:10px;"></i>Nenhuma ocorrência pendente! Operação limpa.</div>`;

    let htmlTratadas = tratadas.map(g => {
        const timeWindow = `${g.timeStart} às ${calcRealEnd(g.timeEnd)}`;
        const elementId = g.ids[0];

        return `
        <div class="card" style="border-left: 4px solid #39FF14; padding: 15px; margin-bottom: 10px; cursor: pointer;" onclick="toggleAnomaly('card-${elementId}')">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <span style="background: var(--eletra-aqua); color: var(--bg-petroleo); padding: 2px 6px; border-radius: 3px; font-size: 0.65rem; font-weight: bold; margin-right: 8px;">${g.tipoFluxo || 'INBOUND'}</span>
                    <strong style="color: var(--eletra-aqua); font-size: 1.1rem;">${g.details.fornecedor || g.details.transp || 'Não Informado'}</strong>
                    <span style="font-size: 0.8rem; color: #888; margin-left: 10px;">Agendado: ${g.date.split('-').reverse().join('/')} - <strong style="color:white;">${timeWindow}</strong></span><br>
                    <span style="color: #39FF14; font-weight: bold; font-size: 0.85rem; margin-top:5px; display:inline-block;"><i class="fa-solid fa-check"></i> Encerrado</span>
                </div>
                <div><i class="fa-solid fa-chevron-down" style="color: #aaa;"></i></div>
            </div>
            
            <div id="card-${elementId}" style="display: none; margin-top: 15px; padding-top: 15px; border-top: 1px solid #333; cursor: default;" onclick="event.stopPropagation()">
                ${buildDiarioDeBordo(g)}
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
            <div id="oc-pendentes" class="tab-content active" style="background: var(--bg-petroleo);">${htmlPendentes}</div>
            <div id="oc-tratadas" class="tab-content" style="background: var(--bg-petroleo);">${htmlTratadas}</div>
        </div>
    `;
}

/* =========================================
   MÓDULO: DIÁRIO DE BORDO (AUDITORIA DE OCORRÊNCIAS)
   ========================================= */
async function renderDiarioDeBordo(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando Diário de Bordo...</div>';
    // Memória da data selecionada (Padrão: Hoje)
    const filterDate = window.currentDiarioDate || SYSTEM_DATE_STR;
    window.currentDiarioDate = filterDate;
    const allAppts = await StorageManager.getAppointments();
    // No Diário de Bordo, mostramos TODOS os agendamentos do dia (Inbound)
    const dailyAppts = allAppts.filter(a => a.date === filterDate && (a.tipoFluxo === 'INBOUND' || !a.tipoFluxo));
    // Agrupa os slots do mesmo caminhão
    const grouped = {};
    dailyAppts.forEach(a => {
        const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`;
        if (!grouped[key]) {
            grouped[key] = {
                date: a.date, timeStart: a.time, timeEnd: a.time,
                details: a.details, status: a.status,
                userName: a.userName, timestamp: a.timestamp || new Date().toISOString(),
                horaChegada: a.horaChegada, horaDescarga: a.horaDescarga, horaSaida: a.horaSaida,
                motivoOcorrencia: a.motivoOcorrencia, statusObs: a.statusObs,
                anomaliaCriadaPor: a.anomaliaCriadaPor, anomaliaCriadaEm: a.anomaliaCriadaEm,
                anomaliaTratadaPor: a.anomaliaTratadaPor, anomaliaTratadaEm: a.anomaliaTratadaEm,
                planoAcao: a.planoAcao, statusUpdatedAt: a.statusUpdatedAt, statusUpdatedBy: a.statusUpdatedBy
            };
        }
        if (a.time < grouped[key].timeStart) grouped[key].timeStart = a.time;
        if (a.time > grouped[key].timeEnd) grouped[key].timeEnd = a.time;
        // Mantém o status mais avançado do agendamento
        if (['FINALIZADO', 'CANCELADO', 'ANOMALIA', 'RESOLVIDO'].includes(a.status)) {
            grouped[key].status = a.status;
        }
        // Agrega os tempos reais da operação para a linha do tempo
        if(a.horaChegada) grouped[key].horaChegada = a.horaChegada;
        if(a.horaDescarga) grouped[key].horaDescarga = a.horaDescarga;
        if(a.horaSaida) grouped[key].horaSaida = a.horaSaida;
        if(a.anomaliaCriadaEm) { grouped[key].anomaliaCriadaEm = a.anomaliaCriadaEm; grouped[key].anomaliaCriadaPor = a.anomaliaCriadaPor; grouped[key].motivoOcorrencia = a.motivoOcorrencia; grouped[key].statusObs = a.statusObs; }
        if(a.anomaliaTratadaEm) { grouped[key].anomaliaTratadaEm = a.anomaliaTratadaEm; grouped[key].anomaliaTratadaPor = a.anomaliaTratadaPor; grouped[key].planoAcao = a.planoAcao; }
    });

    const calcRealEnd = (timeStr) => {
        let [h, m] = timeStr.split(':').map(Number);
        m += 10; if (m >= 60) { h++; m -= 60; }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    // Ordena pelo horário de início do agendamento
    const groupedArray = Object.values(grouped).sort((a,b) => a.timeStart.localeCompare(b.timeStart));

    let cardsHtml = groupedArray.map((g, index) => {
        const timeWindow = `${g.timeStart} às ${calcRealEnd(g.timeEnd)}`;
        const elementId = `db-card-${index}`;
        
        let statusColor = '#aaa';
        if(g.status === 'AGENDADO') statusColor = 'var(--eletra-aqua)';
        else if (g.status === 'CHEGOU' || g.status === 'EM DESCARGA') statusColor = 'var(--eletra-orange)';
        else if (g.status === 'FINALIZADO' || g.status === 'RESOLVIDO') statusColor = '#39FF14';
        else if (g.status === 'CANCELADO' || g.status === 'ANOMALIA' || g.status === 'ATRASADO') statusColor = '#FF3131';

        // ----------------------------------------------------
        // CONSTRUÇÃO DA LINHA DO TEMPO (HISTÓRICO DE EVENTOS)
        // ----------------------------------------------------
        let timeline = [];
        if(g.timestamp) timeline.push({ time: g.timestamp, text: `Agendamento criado por <strong>${g.userName}</strong>`, icon: 'fa-calendar-check', color: '#00D4FF' });
        if(g.horaChegada) timeline.push({ time: g.horaChegada, text: `Chegada registrada (Portaria)`, icon: 'fa-truck-arrow-right', color: 'var(--eletra-orange)' });
        if(g.horaDescarga) timeline.push({ time: g.horaDescarga, text: `Início de Descarga (Doca)`, icon: 'fa-dolly', color: 'var(--eletra-orange)' });
        if(g.horaSaida) timeline.push({ time: g.horaSaida, text: `Saída registrada / Operação Finalizada`, icon: 'fa-check-double', color: '#39FF14' });
        if(g.anomaliaCriadaEm) timeline.push({ time: g.anomaliaCriadaEm, text: `Anomalia apontada por <strong>${g.anomaliaCriadaPor}</strong><br><span style="color:#aaa;">Motivo: ${g.motivoOcorrencia} ${g.statusObs ? '('+g.statusObs+')' : ''}</span>`, icon: 'fa-triangle-exclamation', color: '#FF3131' });
        if(g.anomaliaTratadaEm) timeline.push({ time: g.anomaliaTratadaEm, text: `Tratativa por <strong>${g.anomaliaTratadaPor}</strong><br><span style="color:#aaa;">Decisão: ${g.planoAcao.decisaoAgenda} <br> Ação: ${g.planoAcao.acao}</span>`, icon: 'fa-gavel', color: '#39FF14' });

        // Ordena a timeline cronologicamente
        timeline.sort((a,b) => new Date(a.time) - new Date(b.time));

        let timelineHtml = timeline.map(t => `
            <div style="position: relative; padding-left: 20px; margin-bottom: 15px;">
                <div style="position: absolute; left: -6px; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: ${t.color}; box-shadow: 0 0 5px ${t.color};"></div>
                <div style="font-size: 0.7rem; color: #888; margin-bottom: 2px;">${new Date(t.time).toLocaleString('pt-BR')}</div>
                <div style="font-size: 0.8rem; color: #ddd;"><i class="fa-solid ${t.icon}" style="color:${t.color}; margin-right:5px;"></i> ${t.text}</div>
            </div>
        `).join('');

        // ----------------------------------------------------
        // RENDERIZAÇÃO DO CARD
        // ----------------------------------------------------
        return `
        <div class="card" style="border-left: 4px solid ${statusColor}; padding: 15px; margin-bottom: 10px; cursor: pointer; transition: 0.2s;" onclick="document.getElementById('${elementId}').style.display = document.getElementById('${elementId}').style.display === 'none' ? 'block' : 'none'" onmouseover="this.style.background='#222'" onmouseout="this.style.background='var(--bg-asfalto)'">
            
            <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px;">
                <div style="flex: 1; min-width: 300px;">
                    <strong style="color:var(--eletra-aqua); font-size:1.1rem;">${timeWindow}</strong> 
                    <span style="color:#888; font-size:0.8rem; margin-left:10px;">Sol: <strong style="color:#ddd;">${g.details.solicitante || '-'}</strong> | Comp: <strong style="color:#ddd;">${g.details.comprador || '-'}</strong></span>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; font-size: 0.8rem; color: #aaa;">
                        <div>
                            <span style="color:#777;">PO Material:</span> <strong style="color:#ddd;">${g.details.poMat}</strong><br>
                            <span style="color:#777;">NF Material:</span> <strong style="color:#ddd;">${g.details.nf}</strong><br>
                            <span style="color:#777;">Fornecedor:</span> <strong style="color:#ddd;">${g.details.fornecedor || '-'}</strong> <span style="font-size:0.7rem;">(${g.details.cnpjFornecedor || '-'})</span>
                        </div>
                        <div>
                            <span style="color:#777;">PO Frete:</span> <strong style="color:#ddd;">${g.details.poFrete || '-'}</strong><br>
                            <span style="color:#777;">CTRC:</span> <strong style="color:#ddd;">${g.details.ctrc || '-'}</strong><br>
                            <span style="color:#777;">Transp:</span> <strong style="color:#ddd;">${g.details.transp || '-'}</strong> <span style="font-size:0.7rem;">(${g.details.cnpjTransp || '-'})</span>
                        </div>
                    </div>
                    
                    <div style="margin-top: 8px; font-size: 0.8rem;">
                        <span style="color:#777;">Obs:</span> <span style="color:#ddd; font-style:italic;">${g.details.obs || 'Nenhuma'}</span>
                    </div>
                </div>
                
                <div style="text-align: right; min-width: 150px;">
                    <span style="border: 1px solid ${statusColor}; color: ${statusColor}; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; display:inline-block; margin-bottom:5px;">
                        ${g.status}
                    </span>
                    ${g.planoAcao ? `<br><span style="font-size:0.7rem; color:#888;">Tratativa: <strong style="color:#39FF14;">${g.planoAcao.decisaoAgenda}</strong></span>` : ''}
                    <div style="margin-top: 15px; color: #888; font-size: 0.75rem;"><i class="fa-solid fa-chevron-down"></i> Histórico Completo</div>
                </div>
            </div>
            
            <div id="${elementId}" style="display: none; margin-top: 15px; padding-top: 15px; border-top: 1px dashed #444; cursor: default;" onclick="event.stopPropagation()">
                <h5 style="color: #aaa; margin-bottom: 15px; text-transform: uppercase;"><i class="fa-solid fa-clock-rotate-left"></i> Histórico de Eventos Logísticos</h5>
                <div style="border-left: 2px solid #333; margin-left: 5px;">
                    ${timelineHtml}
                </div>
            </div>
        </div>
        `;
    }).join('');

    if (groupedArray.length === 0) cardsHtml = `<div style="text-align:center; padding:40px; color:#888; font-style:italic;">Nenhum agendamento encontrado para esta data.</div>`;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('db-inbound')">Inbound</button>
                <button class="tab-btn" onclick="switchTab('db-outbound')">Outbound</button>
                <button class="tab-btn" onclick="switchTab('db-transfer')">Transfer</button>
            </div>
            
            <div id="db-inbound" class="tab-content active" style="background: var(--bg-petroleo);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; background:#1a1d21; padding:15px; border-radius:4px; border:1px solid var(--border-color); flex-wrap:wrap; gap:10px;">
                    <div>
                        <label style="font-size:0.8rem; color:#aaa; margin-right:10px;">Data do Diário:</label>
                        <input type="date" id="diario-date" value="${filterDate}" onchange="window.currentDiarioDate = this.value; renderDiarioDeBordo(document.getElementById('workspace'))" style="background:#0b0e11; color:white; border:1px solid #444; padding:5px; border-radius:3px;">
                    </div>
                    <div style="text-align:right;">
                        <span style="color:var(--eletra-aqua); font-weight:bold; font-size:1.2rem;">${groupedArray.length}</span> <span style="font-size:0.7rem; color:#888; text-transform:uppercase;">Agendamentos (Inbound)</span>
                    </div>
                </div>

                <div style="display:flex; flex-direction:column; gap: 5px;">
                    ${cardsHtml}
                </div>
            </div>

            <div id="db-outbound" class="tab-content"><p style="padding:40px; text-align:center;">Diário de Bordo Outbound em construção.</p></div>
            <div id="db-transfer" class="tab-content"><p style="padding:40px; text-align:center;">Diário de Bordo Transfer em construção.</p></div>
        </div>
    `;
}

// Expande ou retrai o Card da Ocorrência
window.toggleAnomaly = function(id) {
    const card = document.getElementById(id);
    if(card) { card.style.display = card.style.display === 'none' ? 'block' : 'none'; }
}

// Salva a ação e encerra a ocorrência na Tratativa de anomalias
window.confirmTratativa = async function(idsString, elementId) {
    const acaoAgenda = document.getElementById(`acao-agenda-${elementId}`).value;
    const acao = document.getElementById(`acao-${elementId}`).value.trim();
    
    if(!acaoAgenda) { notify("Selecione a Decisão Estratégica da Agenda.", "error"); return; }
    if(!acao) { notify("Descreva a justificativa da auditoria.", "error"); return; }
    
    const temposManuais = {
        chegada: document.getElementById(`t-chegada-${elementId}`) ? document.getElementById(`t-chegada-${elementId}`).value : null,
        descarga: document.getElementById(`t-descarga-${elementId}`) ? document.getElementById(`t-descarga-${elementId}`).value : null,
        saida: document.getElementById(`t-saida-${elementId}`) ? document.getElementById(`t-saida-${elementId}`).value : null
    };

    if(acaoAgenda === 'RESOLVER_MANUAL' && (!temposManuais.chegada || !temposManuais.saida)) {
        if(!confirm("Tempos em branco! Isso prejudicará o Relatório de Lead Time. Deseja prosseguir mesmo assim?")) return;
    }
    
    if(!confirm(`Confirma a tratativa definitiva com a decisão: ${acaoAgenda}?`)) return;
    
    const plano = { acao: acao, decisaoAgenda: acaoAgenda, responsavel: CURRENT_USER.name, timestamp: new Date().toISOString() };
    
    const res = await StorageManager.saveTratativa(idsString, plano, acaoAgenda, temposManuais);
    if(res.success) {
        notify("Ocorrência encerrada com sucesso!", "success");
        renderOcorrencias(document.getElementById('workspace')); 
    } else { notify(res.msg, "error"); }
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
    
    // Copiar o HTML rico (Tabela com cores)
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

/* =========================================
   MÓDULO: RELATÓRIOS INBOUND (OTD, EFETIVIDADE, LEAD TIME)
   ========================================= */

// Função Helper para agrupar as viagens e não duplicar dados
async function getGroupedInboundData() {
    const allAppts = await StorageManager.getAppointments();
    const grouped = {};
    allAppts.forEach(a => {
        const key = a.timestamp || `${a.details.poMat}_${a.details.nf}_${a.location}`;
        if(!grouped[key]) { grouped[key] = { ...a, timeStart: a.time, timeEnd: a.time }; }
        if (a.time < grouped[key].timeStart) grouped[key].timeStart = a.time;
        if (a.time > grouped[key].timeEnd) grouped[key].timeEnd = a.time;
        if (a.anomaliaTratada) { grouped[key].anomaliaTratada = true; grouped[key].planoAcao = a.planoAcao; }
    });
    return Object.values(grouped).filter(v => v.tipoFluxo === 'INBOUND' || !v.tipoFluxo);
}

// 1. ROTINA: INBOUND OTD (On-Time Delivery)
async function renderInboundOTD(container) {
    container.innerHTML = '<div style="color:white; padding:40px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Calculando OTD Inbound...</div>';
    
    const viagens = await getGroupedInboundData();
    const concluidas = viagens.filter(v => v.status === 'FINALIZADO' || v.status === 'ATRASADO' || (v.horaChegada));
    
    let noPrazo = 0; let atrasados = 0;
    
    concluidas.forEach(v => {
        if(v.horaChegada) {
            // Compara o dia/hora agendado com a hora real do clique de 'CHEGOU'
            const dataAgendadaStr = `${v.date}T${v.timeEnd}:59`;
            if (new Date(v.horaChegada) <= new Date(dataAgendadaStr)) { noPrazo++; } 
            else { atrasados++; }
        } else if (v.status === 'ATRASADO') {
            atrasados++;
        }
    });

    const total = noPrazo + atrasados;
    const otdPct = total > 0 ? ((noPrazo / total) * 100).toFixed(1) : 0;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px; padding:30px;">
            <h3 style="color:var(--eletra-aqua); margin-bottom:20px;"><i class="fa-solid fa-clock"></i> OTD INBOUND (On-Time Delivery)</h3>
            <p style="color:#888; font-size:0.8rem; margin-bottom:25px;">Mede o cumprimento da janela de agendamento por parte das transportadoras.</p>
            
            <div style="display:flex; gap:20px; flex-wrap:wrap;">
                <div class="card" style="flex:1; text-align:center; padding:40px; border-left:4px solid #39FF14; background:#111;">
                    <div style="font-size:4rem; font-weight:bold; color:#39FF14;">${otdPct}<span style="font-size:2rem;">%</span></div>
                    <div style="font-size:0.9rem; color:#888; text-transform:uppercase; margin-top:10px;">Taxa de Pontualidade</div>
                </div>
                <div style="flex:1; display:flex; flex-direction:column; gap:15px;">
                    <div class="card" style="margin:0; padding:20px; border-left:4px solid #00D4FF; display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#aaa; font-weight:bold;">No Prazo (Chegada Real <= Agendado)</span>
                        <span style="font-size:1.5rem; color:#00D4FF; font-weight:bold;">${noPrazo}</span>
                    </div>
                    <div class="card" style="margin:0; padding:20px; border-left:4px solid #FF3131; display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#aaa; font-weight:bold;">Atrasados / Fora da Janela</span>
                        <span style="font-size:1.5rem; color:#FF3131; font-weight:bold;">${atrasados}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// 2. ROTINA: INBOUND EFETIVIDADE (Sucesso x Anomalias)
async function renderInboundEfetividade(container) {
    container.innerHTML = '<div style="color:white; padding:40px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Processando Efetividade...</div>';
    
    const viagens = await getGroupedInboundData();
    const encerradas = viagens.filter(v => v.status === 'FINALIZADO' || v.status === 'ANOMALIA' || v.anomaliaTratada);
    
    const anomalias = encerradas.filter(v => v.status === 'ANOMALIA' || v.anomaliaTratada).length;
    const sucesso = encerradas.length - anomalias;
    const efetividadePct = encerradas.length > 0 ? ((sucesso / encerradas.length) * 100).toFixed(1) : 0;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px; padding:30px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                    <h3 style="color:var(--eletra-aqua); margin-bottom:5px;"><i class="fa-solid fa-shield-halved"></i> EFETIVIDADE INBOUND</h3>
                    <p style="color:#888; font-size:0.8rem; margin-bottom:25px;">Qualidade do recebimento. Operações limpas vs Operações com atrito estrutural.</p>
                </div>
                <button class="mark-btn action apply" onclick="loadPage('Ocorrências', 'MONITORAMENTO')">
                    <i class="fa-solid fa-up-right-from-square"></i> Detalhar Anomalias
                </button>
            </div>
            
            <div style="display:flex; gap:20px; flex-wrap:wrap;">
                <div class="card" style="flex:1; text-align:center; padding:40px; border-left:4px solid var(--eletra-aqua); background:#111;">
                    <div style="font-size:4rem; font-weight:bold; color:var(--eletra-aqua);">${efetividadePct}<span style="font-size:2rem;">%</span></div>
                    <div style="font-size:0.9rem; color:#888; text-transform:uppercase; margin-top:10px;">Taxa de Sucesso / Sem Atrito</div>
                </div>
                <div style="flex:1; display:flex; flex-direction:column; gap:15px;">
                    <div class="card" style="margin:0; padding:20px; border-left:4px solid #39FF14; display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#aaa; font-weight:bold;">Operações com Sucesso Absoluto</span>
                        <span style="font-size:1.5rem; color:#39FF14; font-weight:bold;">${sucesso}</span>
                    </div>
                    <div class="card" style="margin:0; padding:20px; border-left:4px solid #FF8200; display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#aaa; font-weight:bold;">Operações com Anomalias Registradas</span>
                        <span style="font-size:1.5rem; color:#FF8200; font-weight:bold;">${anomalias}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// 3. ROTINA: INBOUND LEAD TIMES (Fila vs Doca)
async function renderInboundLeadTimes(container) {
    container.innerHTML = '<div style="color:white; padding:40px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Processando Cronômetros Logísticos...</div>';
    
    const viagens = await getGroupedInboundData();
    
    let filaTotalMin = 0, descTotalMin = 0, countFila = 0, countDesc = 0;
    
    // Apenas finalizados para não corromper a média com caminhões que ainda estão no pátio
    viagens.filter(v => v.status === 'FINALIZADO').forEach(v => {
        if(v.horaChegada && v.horaDescarga) {
            const diffFila = (new Date(v.horaDescarga) - new Date(v.horaChegada)) / 60000;
            if(diffFila >= 0) { filaTotalMin += diffFila; countFila++; }
        }
        if(v.horaDescarga && v.horaSaida) {
            const diffDesc = (new Date(v.horaSaida) - new Date(v.horaDescarga)) / 60000;
            if(diffDesc >= 0) { descTotalMin += diffDesc; countDesc++; }
        }
    });

    const avgFila = countFila > 0 ? (filaTotalMin / countFila).toFixed(0) : 0;
    const avgDesc = countDesc > 0 ? (descTotalMin / countDesc).toFixed(0) : 0;

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px; padding:30px;">
            <h3 style="color:var(--eletra-aqua); margin-bottom:20px;"><i class="fa-solid fa-stopwatch"></i> LEAD TIMES INBOUND</h3>
            <p style="color:#888; font-size:0.8rem; margin-bottom:25px;">Tempo médio de processamento físico do veículo dentro das instalações da Eletra.</p>
            
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:30px;">
                <div class="card" style="margin:0; text-align:center; padding:30px; border-left:4px solid var(--eletra-orange); background:#111;">
                    <h4 style="color:#888; font-size:0.85rem; text-transform:uppercase; margin-bottom:10px;">Tempo Médio de Fila</h4>
                    <div style="font-size:3.5rem; font-weight:bold; color:var(--eletra-orange);">${avgFila} <span style="font-size:1.2rem;">min</span></div>
                    <div style="font-size:0.75rem; color:#666; margin-top:10px;"><i class="fa-solid fa-arrow-right-to-bracket"></i> Apontou Chegada até Apontar Descarga</div>
                </div>

                <div class="card" style="margin:0; text-align:center; padding:30px; border-left:4px solid #00D4FF; background:#111;">
                    <h4 style="color:#888; font-size:0.85rem; text-transform:uppercase; margin-bottom:10px;">Tempo Médio de Doca / Descarga</h4>
                    <div style="font-size:3.5rem; font-weight:bold; color:#00D4FF;">${avgDesc} <span style="font-size:1.2rem;">min</span></div>
                    <div style="font-size:0.75rem; color:#666; margin-top:10px;"><i class="fa-solid fa-dolly"></i> Apontou Descarga até Apontar Saída</div>
                </div>
            </div>
        </div>
    `;
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
    const dateInput = document.getElementById('home-date') || document.getElementById('in-date');
    const date = dateInput ? dateInput.value : SYSTEM_DATE_STR;
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

// Clipboard para Confirmação de Agendamento (E-mail para o Fornecedor/Transportadora)
window.copyBookingConfirmation = function(poMat, nf, forn, data, hora, acao) {
    const isCancelamento = acao === 'CANCELAR';
    const corTema = isCancelamento ? '#FF3131' : '#00D4FF';
    const titulo = isCancelamento ? 'Cancelamento de Agendamento' : 'Confirmação de Agendamento';
    
    // Pega os dados do usuário logado (que está gerando o e-mail)
    const userEmail = CURRENT_USER.email || 'Não cadastrado';
    const userTel = CURRENT_USER.telefone || 'Não cadastrado';

    const html = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px;">
            <h3 style="color: ${corTema}; border-bottom: 2px solid ${corTema}; padding-bottom: 5px; margin-top: 0;">
                ${isCancelamento ? '🚫' : '✅'} ${titulo} - Inbound Eletra Energy
            </h3>
            <p>Prezados,</p>
            <p>${isCancelamento ? 'Informamos que o agendamento abaixo foi <strong>CANCELADO</strong> em nosso sistema e a doca foi liberada.' : 'Informamos que o seu agendamento foi <strong>CONFIRMADO</strong> com sucesso em nosso sistema de recebimento.'}</p>
            
            <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; border-color: #ccc; margin-top:15px; margin-bottom:15px;">
                <tr style="background-color: #f9f9f9;">
                    <th style="text-align: left; width: 35%; color: #555;">Fornecedor/Transp.</th>
                    <td style="font-weight: bold; color: #000;">${forn || 'Conforme NF'}</td>
                </tr>
                <tr>
                    <th style="text-align: left; color: #555;">Documentos Ref.</th>
                    <td><strong>NF:</strong> ${nf} &nbsp;|&nbsp; <strong>PO:</strong> ${poMat}</td>
                </tr>
                <tr style="background-color: #f9f9f9;">
                    <th style="text-align: left; color: #555;">Data Agendada</th>
                    <td style="font-weight: bold;">${data.split('-').reverse().join('/')}</td>
                </tr>
                <tr>
                    <th style="text-align: left; color: #555;">Horário (Janela)</th>
                    <td style="font-weight: bold; color: ${corTema};">${hora}</td>
                </tr>
                <tr style="background-color: #f9f9f9;">
                    <th style="text-align: left; color: #555;">Local de Entrega</th>
                    <td>Eletra Energy - Matriz (Doca de Recebimento)</td>
                </tr>
            </table>
            
            ${!isCancelamento ? `
            <p style="font-size: 0.85em; color: #666; margin-bottom:20px;">
                <strong>⚠️ REGRAS DE RECEBIMENTO:</strong><br>
                - A tolerância de atraso é de 15 minutos.<br>
                - O motorista deve apresentar EPI obrigatório (Bota e Colete).<br>
                - Em caso de atraso, o veículo estará sujeito a reencaixe ou recusa.
            </p>` : ''}
            
            <p style="margin: 5px 0; font-size: 0.9em;">Atenciosamente,</p>
            <p style="margin: 5px 0; font-weight: bold; color: var(--eletra-aqua);">${CURRENT_USER.name}</p>
            <p style="margin: 0; font-size: 0.85em; color: #777;">Logística Eletra Energy<br>Email: ${userEmail}<br>Tel: ${userTel}</p>
        </div>
    `;
    
    const tempElement = document.createElement("div");
    tempElement.innerHTML = html;
    document.body.appendChild(tempElement);
    
    const range = document.createRange();
    range.selectNode(tempElement);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    
    try {
        document.execCommand("copy");
        notify("Texto de e-mail copiado! Cole no seu Outlook/Gmail.", "info");
    } catch (err) {
        notify("Erro ao copiar para a área de transferência.", "error");
    }
    
    window.getSelection().removeAllRanges();
    document.body.removeChild(tempElement);
}

/* =========================================
   MÓDULO: FORNECEDOR (UI E FORMULÁRIO)
   ========================================= */
async function renderFornecedor(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando base de fornecedores...</div>';
    
    const fornecedores = await StorageManager.getFornecedores();
    
    let rows = fornecedores.map(f => `
        <tr style="border-bottom:1px solid #333; font-size: 0.85rem;">
            <td style="padding:10px;">${f.cnpj}</td>
            <td>
                <strong style="color:var(--eletra-aqua);">${f.razao}</strong><br>
                <span style="font-size:0.7rem; color:#888;">Cod: ${f.codigoProtheus || '-'} | Loja: ${f.lojaProtheus || '-'}</span>
            </td>
            <td><span style="font-size:0.75rem; color:#bbb;">${f.enderecoCompleto || '-'}</span></td>
            <td><span style="font-size:0.75rem;">${f.contatoNome || '-'}<br>${f.contatoTel || f.contatoEmail || '-'}</span></td>
            <td style="text-align:right;">
                <button class="mark-btn" style="border-color:#00D4FF; color:#00D4FF; padding:4px 8px;" onclick="handleEditFornecedor('${f.id_doc}')"><i class="fa-solid fa-pencil"></i></button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 8px;" onclick="handleDeleteFornecedor('${f.id_doc}')"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" id="tab-forn-geral" onclick="switchTab('forn-geral')">Ficha Cadastral</button>
                <button class="tab-btn" onclick="switchTab('forn-lista')" style="color:var(--eletra-orange)">Base Protheus (${fornecedores.length})</button>
                <button class="tab-btn" onclick="triggerCSVImport()" style="margin-left:auto; color:#39FF14; border:1px solid #39FF14; background:rgba(57,255,20,0.05); border-radius:4px;"><i class="fa-solid fa-file-csv"></i> Importar Protheus</button>
            </div>
            
            <div id="forn-geral" class="tab-content active">
                <input type="hidden" id="f-id-doc">

                <fieldset class="prop-group">
                    <legend>IDENTIFICAÇÃO ERP PROTHEUS</legend>
                    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>CNPJ*</label>
                            <input type="text" id="f-cnpj" placeholder="Apenas números" oninput="autoFillCodigoLoja(this)" maxlength="18">
                        </div>
                        <div class="form-row-col"><label>Código (Auto)</label><input type="text" id="f-codigo" readonly style="background:#222; color:#aaa;" title="Primeiros 8 dígitos do CNPJ"></div>
                        <div class="form-row-col"><label>Loja (Auto)</label><input type="text" id="f-loja" readonly style="background:#222; color:#aaa;" title="Restantes 6 dígitos do CNPJ"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>Razão Social*</label><input type="text" id="f-razao"></div>
                        <div class="form-row-col"><label>Nome Fantasia</label><input type="text" id="f-fantasia"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>ENDEREÇO E GEOLOCALIZAÇÃO</legend>
                    <div style="display: grid; grid-template-columns: 1fr 2fr 1fr; gap: 10px;">
                        <div class="form-row-col">
                            <label>CEP (Preferencial) <i class="fa-solid fa-magnifying-glass" style="color:var(--eletra-aqua); cursor:pointer;" onclick="buscaCepFornecedor()"></i></label>
                            <input type="text" id="f-cep" placeholder="00000-000" oninput="applyCepMask(this)" onblur="buscaCepFornecedor()" maxlength="9">
                        </div>
                        <div class="form-row-col"><label>Logradouro / Rua</label><input type="text" id="f-rua" oninput="atualizarEnderecoCompletoFornecedor()"></div>
                        <div class="form-row-col"><label>Número</label><input type="text" id="f-num" oninput="atualizarEnderecoCompletoFornecedor()"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>Bairro</label><input type="text" id="f-bairro" oninput="atualizarEnderecoCompletoFornecedor()"></div>
                        <div class="form-row-col"><label>Cidade</label><input type="text" id="f-cidade" oninput="atualizarEnderecoCompletoFornecedor()"></div>
                        <div class="form-row-col"><label>UF</label><input type="text" id="f-uf" maxlength="2" oninput="atualizarEnderecoCompletoFornecedor()"></div>
                    </div>
                    <div class="form-row-col" style="margin-top:10px;">
                        <label>Endereço Completo (Consolidado Automático)</label>
                        <input type="text" id="f-end-completo" readonly style="background:#222; color:#aaa;">
                    </div>
                </fieldset>

                <fieldset class="prop-group">
                    <legend>CONTATO OPERACIONAL</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                        <div class="form-row-col"><label>Nome do Contato</label><input type="text" id="f-contato-nome" placeholder="Responsável"></div>
                        <div class="form-row-col"><label>Telefone</label><input type="text" id="f-telefone" placeholder="(DD) 90000-0000"></div>
                        <div class="form-row-col"><label>E-mail</label><input type="email" id="f-email" placeholder="email@fornecedor.com"></div>
                    </div>
                </fieldset>

                <div class="props-footer">
                    <button id="btn-save-forn" class="mark-btn action apply" onclick="handleSaveFornecedor()">SALVAR NO BANCO</button>
                    <button class="mark-btn action" onclick="renderFornecedor(document.getElementById('workspace'))">LIMPAR</button>
                </div>
            </div>

            <div id="forn-lista" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>CNPJ</th><th>Fornecedor / ERP</th><th>Endereço Completo</th><th>Contato</th><th>Ações</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan=\"5\" style=\"text-align:center;\">Nenhum fornecedor na base.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;
}

// Função que quebra o CNPJ em Código (8) e Loja (6)
function autoFillCodigoLoja(input) {
    let val = input.value.replace(/\D/g, '');
    if (val.length >= 14) {
        document.getElementById('f-codigo').value = val.substring(0, 8);
        document.getElementById('f-loja').value = val.substring(8, 14);
    } else {
        document.getElementById('f-codigo').value = '';
        document.getElementById('f-loja').value = '';
    }
}

// Busca CEP Inteligente
async function buscaCepFornecedor() {
    let cep = document.getElementById('f-cep').value.replace(/\D/g, '');
    if (cep.length === 8) {
        try {
            let response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
            let data = await response.json();
            if (!data.erro) {
                document.getElementById('f-rua').value = data.logradouro;
                document.getElementById('f-bairro').value = data.bairro;
                document.getElementById('f-cidade').value = data.localidade;
                document.getElementById('f-uf').value = data.uf;
                document.getElementById('f-num').focus();
                atualizarEnderecoCompletoFornecedor();
            } else { notify("CEP não encontrado.", "error"); }
        } catch(e) { console.error(e); }
    }
}

function atualizarEnderecoCompletoFornecedor() {
    let rua = document.getElementById('f-rua').value.trim();
    let num = document.getElementById('f-num').value.trim() || 'S/N';
    let bairro = document.getElementById('f-bairro').value.trim();
    let cid = document.getElementById('f-cidade').value.trim();
    let uf = document.getElementById('f-uf').value.trim();
    document.getElementById('f-end-completo').value = `${rua}, ${num} - ${bairro}, ${cid}/${uf}`;
}

async function processarCSVProtheus(csvText) {
    notify("Analisando estrutura do arquivo CSV...", "info");
    const delimiter = csvText.indexOf(';') !== -1 ? ';' : ',';
    const lines = [];
    let currentLine = [];
    let currentStr = '';
    let insideQuote = false;

    // 1. FATIAMENTO
    for (let i = 0; i < csvText.length; i++) {
        const char = csvText[i];
        if (char === '"') { insideQuote = !insideQuote; } 
        else if (char === delimiter && !insideQuote) { currentLine.push(currentStr); currentStr = ''; } 
        else if (char === '\n' && !insideQuote) { currentLine.push(currentStr); lines.push(currentLine); currentLine = []; currentStr = ''; } 
        else if (char !== '\r') { currentStr += char; }
    }
    if (currentStr || currentLine.length > 0) { currentLine.push(currentStr); lines.push(currentLine); }

    // 2. BUSCA DO CABEÇALHO
    let headerIndex = -1;
    for(let i=0; i < Math.min(10, lines.length); i++) {
        if(lines[i].some(col => col.includes('CNPJ/CPF') || col.includes('CNPJ') || col.includes('CPF'))) { headerIndex = i; break; }
    }

    if (headerIndex === -1) { notify("Erro: Coluna de CNPJ/CPF não encontrada no cabeçalho.", "error"); return; }

    const headers = lines[headerIndex].map(h => h.replace(/^"|"$/g, '').trim().toUpperCase());
    
    // 3. MAPEAMENTO EXATO (Apenas as colunas solicitadas)
    const idx = {
        cnpj: headers.findIndex(h => h === 'CNPJ/CPF' || h === 'CNPJ' || h === 'CPF'),
        codigo: headers.findIndex(h => h === 'CODIGO' || h === 'CÓDIGO'),
        loja: headers.findIndex(h => h === 'LOJA'),
        razao: headers.findIndex(h => h === 'RAZAO SOCIAL' || h === 'RAZÃO SOCIAL' || h === 'NOME'),
        fantasia: headers.findIndex(h => h === 'N FANTASIA' || h === 'NOME FANTASIA' || h === 'FANTASIA'),
        endereco: headers.findIndex(h => h === 'ENDERECO' || h === 'ENDEREÇO' || h === 'LOGRADOURO'),
        bairro: headers.findIndex(h => h === 'BAIRRO'),
        estado: headers.findIndex(h => h === 'ESTADO' || h === 'UF'),
        email: headers.findIndex(h => h === 'E-MAIL' || h === 'EMAIL')
    };

    const fornecedores = [];
    const timestamp = new Date().toISOString();

    // 4. LEITURA DOS DADOS
    for (let i = headerIndex + 1; i < lines.length; i++) {
        const col = lines[i];
        if (!col || col.length < 2 || idx.cnpj === -1) continue;

        const getVal = (index) => index > -1 && col[index] ? col[index].replace(/^"|"$/g, '').trim() : '';

        // 5. REGRA CPF/CNPJ
        let cnpjBase = getVal(idx.cnpj).replace(/\D/g, ''); // Arranca tudo que não for número
        
        // Se não for CPF (11) nem CNPJ (14), a linha é lixo do Excel, ignoramos.
        if (cnpjBase.length !== 11 && cnpjBase.length !== 14) continue; 
        
        // 6. TRATAMENTO DE CÓDIGO E LOJA
        let codProtheus = getVal(idx.codigo);
        let lojaProtheus = getVal(idx.loja);
        
        // Se a coluna estiver vazia, mas for um CNPJ (14), ele corta a string. Se for CPF (11), fica vazio.
        if (!codProtheus && cnpjBase.length === 14) codProtheus = cnpjBase.substring(0,8);
        if (!lojaProtheus && cnpjBase.length === 14) lojaProtheus = cnpjBase.substring(8,14);
        
        let rua = getVal(idx.endereco);
        let bairro = getVal(idx.bairro);
        let uf = getVal(idx.estado);
        let enderecoCompleto = `${rua} - ${bairro}, ${uf}`.replace(/^[,\- ]+|[,\- ]+$/g, '').trim(); // Remove pontuações sobrando

        // 7. MONTAGEM DA FICHA PARA O BANCO DE DADOS
        fornecedores.push({
            cnpj: cnpjBase,
            codigoProtheus: codProtheus || '',
            lojaProtheus: lojaProtheus || '',
            razao: getVal(idx.razao) || 'NÃO INFORMADO',
            fantasia: getVal(idx.fantasia),
            enderecoCompleto: enderecoCompleto,
            rua: rua,
            bairro: bairro,
            uf: uf,
            contatoEmail: getVal(idx.email),
            categoria: 'Geral',
            // Campos de estabilidade para a UI não dar erro
            cep: '', numero: '', cidade: '', contatoNome: '', contatoTel: '', lat: '', lng: '', mapLink: '',
            user: CURRENT_USER.name,
            timestamp: timestamp
        });
    }

    if (fornecedores.length === 0) { notify("Nenhum fornecedor válido encontrado.", "error"); return; }
    if (!confirm(`Análise concluída!\nForam detetados ${fornecedores.length} fornecedores válidos (CPF/CNPJ).\n\nImportar para o banco de dados?`)) return;

    // 8. ENVIO PARA O BANCO (Deduplicação automática ocorre dentro do StorageManager)
    const res = await StorageManager.saveFornecedoresBatch(fornecedores);
    if (res.success) {
        notify(`Sucesso! ${res.count} registros sincronizados.`, "success");
        renderFornecedor(document.getElementById('workspace'));
    } else { notify(res.msg, "error"); }
}

async function handleSaveFornecedor() {
    const idDoc = document.getElementById('f-id-doc').value;
    const cnpj = document.getElementById('f-cnpj').value.replace(/\D/g, '');
    const razao = document.getElementById('f-razao').value.trim();
    
    if (!cnpj || !razao) { 
        notify("CNPJ e Razão Social são de preenchimento obrigatório.", "error"); 
        return; 
    }

    const payload = {
        cnpj: cnpj,
        codigoProtheus: document.getElementById('f-codigo').value.trim() || (cnpj.length >= 14 ? cnpj.substring(0,8) : 'AVULSO'),
        lojaProtheus: document.getElementById('f-loja').value.trim() || (cnpj.length >= 14 ? cnpj.substring(8,14) : '01'),
        razao: razao.toUpperCase(),
        fantasia: document.getElementById('f-fantasia').value.trim(),
        cep: document.getElementById('f-cep').value.trim(),
        rua: document.getElementById('f-rua').value.trim(),
        numero: document.getElementById('f-num').value.trim(),
        bairro: document.getElementById('f-bairro').value.trim(),
        cidade: document.getElementById('f-cidade').value.trim(),
        uf: document.getElementById('f-uf').value.toUpperCase(),
        enderecoCompleto: document.getElementById('f-end-completo').value.trim(),
        contatoNome: document.getElementById('f-contato-nome').value.trim(),
        contatoTel: document.getElementById('f-telefone').value.trim(),
        contatoEmail: document.getElementById('f-email').value.trim(),
        categoria: 'Avulso',
        // Dados preparados para o Módulo de Planejamento (GeoSpatial)
        lat: '', 
        lng: '',
        mapLink: '',
        user: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    if (idDoc) {
        if (!confirm(`Atualizar cadastro de ${razao}?`)) return;
        const res = await StorageManager.updateFornecedor(idDoc, payload);
        if (res.success) { notify("Fornecedor atualizado!"); renderFornecedor(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    } else {
        if (!confirm(`Salvar o fornecedor ${razao}?`)) return;
        const res = await StorageManager.saveFornecedor(payload);
        if (res.success) { notify("Fornecedor avulso cadastrado!"); renderFornecedor(document.getElementById('workspace')); }
        else { notify(res.msg, "error"); }
    }
}

async function handleEditFornecedor(id) {
    const f = await StorageManager.getFornecedorById(id);
    if (!f) return;

    document.getElementById('f-id-doc').value = f.id_doc || '';
    document.getElementById('f-cnpj').value = f.cnpj || '';
    document.getElementById('f-codigo').value = f.codigoProtheus || '';
    document.getElementById('f-loja').value = f.lojaProtheus || '';
    document.getElementById('f-razao').value = f.razao || '';
    document.getElementById('f-fantasia').value = f.fantasia || '';
    document.getElementById('f-cep').value = f.cep || '';
    document.getElementById('f-rua').value = f.rua || '';
    document.getElementById('f-num').value = f.numero || '';
    document.getElementById('f-bairro').value = f.bairro || '';
    document.getElementById('f-cidade').value = f.cidade || '';
    document.getElementById('f-uf').value = f.uf || '';
    document.getElementById('f-end-completo').value = f.enderecoCompleto || '';
    document.getElementById('f-contato-nome').value = f.contatoNome || '';
    document.getElementById('f-telefone').value = f.contatoTel || '';
    document.getElementById('f-email').value = f.contatoEmail || '';
    document.getElementById('btn-save-forn').innerText = "ATUALIZAR DADOS";
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('forn-geral').classList.add('active');
    document.getElementById('tab-forn-geral').classList.add('active');
}

async function handleDeleteFornecedor(id) {
    if(!confirm("Atenção: Tem certeza que deseja apagar este fornecedor?")) return;
    await StorageManager.deleteFornecedor(id);
    notify("Fornecedor apagado com sucesso.");
    renderFornecedor(document.getElementById('workspace'));
}

/* =========================================
   MÓDULO CADASTROS: ITINERÁRIOS (ROTEIRIZADOR)
   ========================================= */
async function renderItinerarios(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3></div>`; return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando malha viária...</div>';
    
    const rotas = await StorageManager.getItinerarios();
    let rows = rotas.map(r => `
        <tr style="border-bottom:1px solid #333;">
            <td>${r.origem.cidadeUF}</td>
            <td>
                <strong style="color:var(--eletra-aqua);">${r.destinos[r.destinos.length-1].cidadeUF}</strong>
                <br><span style="font-size:0.65rem; color:#888;">${r.destinos.length} Parada(s)</span>
            </td>
            <td><span style="color:#39FF14; font-weight:bold;">${r.distanciaKm} km</span></td>
            <td><span style="color:var(--eletra-orange); font-weight:bold;">${r.leadTimeDias} Dias</span></td>
            <td><button class="mark-btn" style="padding:4px 8px;"><i class="fa-solid fa-eye"></i></button></td>
        </tr>
    `).join('');

    // Gera os campos HTML para até 5 destinos
    let destinosHtml = '';
    for(let i=1; i<=5; i++) {
        destinosHtml += `
        <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 10px; margin-bottom:5px; padding-left:20px; border-left:2px solid #444;">
            <div class="form-row-col">
                <label>Parada ${i} (CEP)</label>
                <input type="text" id="iti-cep-${i}" placeholder="00000-000" oninput="applyCepMask(this)" onblur="buscaCepItinerario('iti-cep-${i}', 'iti-cid-${i}')" maxlength="9">
            </div>
            <div class="form-row-col">
                <label>Cidade / UF (Parada ${i})</label>
                <input type="text" id="iti-cid-${i}" readonly style="background:#222; color:#aaa;" placeholder="Aguardando CEP...">
            </div>
        </div>`;
    }

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('iti-geral')">Criar Rota / Roteirizar</button>
                <button class="tab-btn" onclick="switchTab('iti-lista')">Malha Cadastrada (${rotas.length})</button>
            </div>
            
            <div id="iti-geral" class="tab-content active">
                <div class="card" style="background:#111; border-color:var(--eletra-aqua);">
                    <h4 style="color:var(--eletra-aqua); margin-bottom:15px;"><i class="fa-solid fa-map-location-dot"></i> Roteirizador Geográfico</h4>
                    
                    <fieldset class="prop-group">
                        <legend>ORIGEM DA CARGA</legend>
                        <div style="display: grid; grid-template-columns: 1fr 2fr; gap: 10px;">
                            <input type="text" id="iti-cep-origem" value="61760-000" oninput="applyCepMask(this)" onblur="buscaCepItinerario('iti-cep-origem', 'iti-cid-origem')" maxlength="9">
                            <div class="form-row-col"><label>Cidade / UF Origem*</label><input type="text" id="iti-cid-origem" value="Eusébio / CE" readonly style="background:#222; color:#aaa;"></div>
                        </div>
                    </fieldset>

                    <fieldset class="prop-group" style="margin-top:15px;">
                        <legend>ROTEIRO DE ENTREGAS (SEQUENCIAL)</legend>
                        ${destinosHtml}
                    </fieldset>

                    <div style="margin-top:20px; text-align:right;">
                        <button class="mark-btn action" style="border-color:#39FF14; color:#39FF14; width:100%; max-width:300px;" onclick="calcularRotaGoogle()"><i class="fa-solid fa-route"></i> CALCULAR ROTA E LEAD TIME</button>
                    </div>

                    <fieldset class="prop-group" style="margin-top:20px; background:rgba(0, 212, 255, 0.05); border-color:var(--eletra-aqua);">
                        <legend>RESULTADO DA ROTEIRIZAÇÃO</legend>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div class="form-row-col"><label style="color:var(--eletra-aqua)">Distância Total Estimada (Km)</label><input type="number" id="iti-distancia" placeholder="Aguardando cálculo..." readonly style="font-weight:bold; font-size:1.2rem; color:var(--eletra-aqua);"></div>
                            <div class="form-row-col"><label style="color:var(--eletra-orange)">Lead Time Logístico (Dias)</label><input type="number" id="iti-leadtime" placeholder="Aguardando cálculo..." readonly style="font-weight:bold; font-size:1.2rem; color:var(--eletra-orange);"></div>
                        </div>
                    </fieldset>

                    <div class="props-footer" style="margin-top:20px; border:none; background:transparent; padding:0;">
                        <button class="mark-btn action apply" style="width:100%;" onclick="salvarItinerario()">SALVAR ROTA NO BANCO</button>
                    </div>
                </div>
            </div>

            <div id="iti-lista" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>Origem</th><th>Destino Final</th><th>Distância (KM)</th><th>Lead Time</th><th>Ações</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" style="text-align:center;">Nenhuma rota cadastrada.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;
}

// 1. Busca Cidade/UF via API Pública baseada no CEP
async function buscaCepItinerario(cepId, cidId) {
    let cep = document.getElementById(cepId).value.replace(/\D/g, '');
    if (cep.length === 8) {
        try {
            let response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
            let data = await response.json();
            if (!data.erro) {
                document.getElementById(cidId).value = `${data.localidade} / ${data.uf}`;
            }
        } catch(e) { console.error("Erro ViaCEP", e); }
    }
}

// Função auxiliar: Converte Cidade/UF em Latitude e Longitude (Grátis via OpenStreetMap)
async function getCoordinates(cidadeUF) {
    if (!cidadeUF || !cidadeUF.includes('/')) return null;
    const partes = cidadeUF.split('/');
    const cidade = partes[0].trim();
    const uf = partes[1].trim();
    const query = encodeURIComponent(`${cidade}, ${uf}, Brazil`);
    
    try {
        let res = await fetch(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`);
        let data = await res.json();
        if(data && data.length > 0) return { lat: data[0].lat, lon: data[0].lon };
    } catch(e) { console.error("Erro geocoding", e); }
    return null;
}

// 2. Cálculo Real da Distância (Open Source Routing) e Lead Time
window.calcularRotaGoogle = async function() {
    const origemCep = document.getElementById('iti-cep-origem').value.replace(/\D/g, '');
    const origemCid = document.getElementById('iti-cid-origem').value;
    
    if(!origemCep || origemCid.includes('Aguardando')) { notify("Insira um CEP de Origem válido.", "error"); return; }
    
    let paradasCidades = [];
    for(let i=1; i<=5; i++) {
        let cep = document.getElementById(`iti-cep-${i}`).value.replace(/\D/g, '');
        let cid = document.getElementById(`iti-cid-${i}`).value;
        if(cep.length === 8 && cid && !cid.includes('Aguardando')) {
            paradasCidades.push(cid);
        }
    }
    
    if(paradasCidades.length === 0) { notify("Insira pelo menos um destino válido.", "error"); return; }

    notify("Mapeando coordenadas (OpenStreetMap)...", "info");

    // 1. Busca Coordenadas
    let coords = [];
    let coordOrigem = await getCoordinates(origemCid);
    if(coordOrigem) coords.push(`${coordOrigem.lon},${coordOrigem.lat}`);
    
    for(let cid of paradasCidades) {
        let coordDest = await getCoordinates(cid);
        if(coordDest) coords.push(`${coordDest.lon},${coordDest.lat}`);
    }

    if(coords.length < 2) {
        notify("Erro ao localizar cidades no mapa. Verifique os CEPs.", "error");
        return;
    }

    notify("Calculando rota rodoviária...", "info");

    // 2. Traça a rota e pega a distância usando OSRM
    let routeString = coords.join(';');
    try {
        let osrmRes = await fetch(`https://router.project-osrm.org/route/v1/driving/${routeString}?overview=false`);
        let routeData = await osrmRes.json();
        
        if(routeData.routes && routeData.routes.length > 0) {
            let distanceMeters = routeData.routes[0].distance;
            let distanciaTotalKm = Math.round(distanceMeters / 1000);

            // 3. FÓRMULA OFICIAL DE LEAD TIME (Sua Regra Exata)
            // Deslocamento médio: 500 km por dia (Arredondado para cima)
            let diasDeslocamento = Math.ceil(distanciaTotalKm / 500);
            
            // Disponibilização de frota: > 1000km = 1 dia, senão 0.5 dia (12h)
            let tempoDisponibilizacao = distanciaTotalKm > 1000 ? 1 : 0.5;
            
            let leadTimeTotal = diasDeslocamento + tempoDisponibilizacao;

            // Atualiza a Interface
            document.getElementById('iti-distancia').value = distanciaTotalKm;
            document.getElementById('iti-leadtime').value = leadTimeTotal;

            notify("Cálculo de Rota Real Concluído!", "success");
        } else {
            notify("Não foi possível traçar rota rodoviária entre estes pontos.", "error");
        }
    } catch(e) {
        console.error(e);
        notify("Falha na comunicação com servidor de rotas.", "error");
    }
}

async function salvarItinerario() {
    const dist = document.getElementById('iti-distancia').value;
    const lt = document.getElementById('iti-leadtime').value;
    if(!dist || !lt) { notify("Calcule a rota antes de salvar.", "error"); return; }

    const origem = { 
        cep: document.getElementById('iti-cep-origem').value, 
        cidadeUF: document.getElementById('iti-cid-origem').value 
    };

    let paradas = [];
    for(let i=1; i<=5; i++) {
        let cep = document.getElementById(`iti-cep-${i}`).value;
        let cid = document.getElementById(`iti-cid-${i}`).value;
        if(cep && cid) paradas.push({ cep, cidadeUF: cid });
    }

    // ID do itinerário: CEP Origem + Último CEP (Ex: 61760000_01001000)
    const rotaId = `${origem.cep.replace(/\D/g,'')}_${paradas[paradas.length-1].cep.replace(/\D/g,'')}`;

    const payload = {
        rotaId: rotaId,
        origem: origem,
        destinos: paradas,
        distanciaKm: parseFloat(dist),
        leadTimeDias: parseFloat(lt),
        user: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    await StorageManager.saveItinerario(payload);
    notify("Itinerário gravado com sucesso.");
    renderItinerarios(document.getElementById('workspace'));
}

/* =========================================
   MÓDULO CADASTROS: TABELAS DE FRETE (CUSTOS E ACESSÓRIOS)
   ========================================= */
async function renderTabelasFrete(container) {
    if (!ROLE_PERMISSIONS[CURRENT_USER.role].canManageUsers) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3></div>`; return;
    }

    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando acordos comerciais...</div>';
    
    const tabelas = await StorageManager.getTabelasFrete();
    const formatBRL = (val) => Number(val).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    let rows = tabelas.map(t => `
        <tr style="border-bottom:1px solid #333;">
            <td>
                <strong style="color:white;">${t.transportadora}</strong><br>
                <span style="font-size:0.65rem; color:var(--eletra-aqua); border:1px solid var(--eletra-aqua); padding:1px 4px; border-radius:3px;">${t.modal || 'RODOVIÁRIO'}</span>
            </td>
            <td>${t.origem || 'Matriz'} <i class="fa-solid fa-arrow-right" style="color:var(--eletra-orange); font-size:0.6rem; margin:0 5px;"></i> <span style="color:var(--eletra-orange); font-weight:bold;">${t.regiaoDestino}</span></td>
            <td>${t.tipoVeiculo}</td>
            <td><span style="color:#39FF14; font-weight:bold;">R$ ${formatBRL(t.valorFixoOuKm)} ${t.tipoCustoPrincipal === 'KM' ? '/ km' : '(Fixo)'}</span></td>
            <td>
                <span style="font-size:0.7rem; color:#aaa;">Diária: R$ ${formatBRL(t.custos.diaria || 0)}</span><br>
                <span style="font-size:0.7rem; color:#aaa;">Capatazia: R$ ${formatBRL(t.custos.capataziaVal || 0)} (${t.custos.capataziaTipo || '-'})</span>
            </td>
            <td style="text-align:right;"><button class="mark-btn" style="padding:4px 8px;"><i class="fa-solid fa-pencil"></i></button></td>
        </tr>
    `).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('tf-geral')">Nova Matriz de Frete</button>
                <button class="tab-btn" onclick="switchTab('tf-lista')">Tabelas Ativas (${tabelas.length})</button>
                <button class="tab-btn" onclick="switchTab('tf-antt')" style="color:#00D4FF;">Tabela ANTT Vigente</button>
            </div>
            
            <div id="tf-geral" class="tab-content active">
                <div class="card" style="background:#111; border-color:var(--eletra-orange);">
                    <h4 style="color:var(--eletra-orange); margin-bottom:15px;"><i class="fa-solid fa-file-contract"></i> Matriz de Custos Logísticos</h4>
                    
                    <fieldset class="prop-group">
                        <legend>ESCOPO DO SERVIÇO</legend>
                        <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px;">
                            <div class="form-row-col">
                                <label>Transportadora (CNPJ ou Nome Livre)</label>
                                <input type="text" id="tf-transp" list="lista-fornecedores-misto" placeholder="Digite para buscar ou texto livre...">
                            </div>
                            <div class="form-row-col">
                                <label style="color:var(--eletra-aqua);">Modal Logístico</label>
                                <select id="tf-modal"><option value="RODOVIÁRIO">Rodoviário</option><option value="AÉREO">Aéreo</option><option value="CABOTAGEM">Cabotagem</option></select>
                            </div>
                        </div>
                    </fieldset>

                    <fieldset class="prop-group" style="margin-top:15px;">
                        <legend>ROTA E EQUIPAMENTO</legend>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                            <div class="form-row-col">
                                <label>Origem (Filial Eletra ou Livre)</label>
                                <input type="text" id="tf-origem" list="lista-filiais" placeholder="Ex: Matriz (Itaitinga)">
                                <datalist id="lista-filiais">
                                    <option value="Matriz (Itaitinga)"></option>
                                    <option value="Filial Livoltek (Fortaleza)"></option>
                                    <option value="Planta AM (Manaus)"></option>
                                    <option value="Escritório PR (Pato Branco)"></option>
                                    <option value="Filial PR (Curitiba)"></option>
                                    <option value="CD SP (São Paulo)"></option>
                                    <option value="Filial SP (Campinas)"></option>
                                </datalist>
                            </div>
                            <div class="form-row-col">
                                <label style="color:var(--eletra-orange);">Destino (Região/Estado ou Livre)</label>
                                <input type="text" id="tf-regiao" placeholder="Ex: SUDESTE ou SP Capital">
                            </div>
                            <div class="form-row-col">
                                <label>Capacidade / Eixos</label>
                                <select id="tf-veiculo">
                                    <option value="2 Eixos (VUC/Toco)">2 Eixos (VUC/Toco/3/4)</option>
                                    <option value="3 Eixos (Truck)">3 Eixos (Truck)</option>
                                    <option value="4 Eixos (Bitruck)">4 Eixos (Bitruck)</option>
                                    <option value="5+ Eixos (Carreta)">5 ou 6 Eixos (Carreta)</option>
                                    <option value="Fracionado">Fracionado (LTL / Aéreo)</option>
                                </select>
                            </div>
                        </div>
                    </fieldset>

                    <fieldset class="prop-group" style="margin-top:15px; border-color:#39FF14;">
                        <legend style="color:#39FF14;">CUSTO PRINCIPAL DO FRETE</legend>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div class="form-row-col">
                                <label>Tipo de Cobrança Base*</label>
                                <select id="tf-tipo-custo">
                                    <option value="KM">Target Operacional (R$ / km)</option>
                                    <option value="FIXO">Frete Fixo / Peso (R$ Total ou R$/Ton)</option>
                                </select>
                            </div>
                            <div class="form-row-col">
                                <label>Valor Base (R$)*</label>
                                <input type="number" id="tf-valor-principal" placeholder="Ex: 4.50" step="0.01">
                            </div>
                        </div>
                    </fieldset>

                    <fieldset class="prop-group" style="margin-top:15px; border-color:#00D4FF;">
                        <legend style="color:#00D4FF;">CUSTOS ACESSÓRIOS (EXTRAS)</legend>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                            <div class="form-row-col"><label>Diária (R$)</label><input type="number" id="tf-diaria" placeholder="Ex: 950.00" step="0.01"></div>
                            <div class="form-row-col"><label>Pernoite (R$)</label><input type="number" id="tf-pernoite"></div>
                            <div class="form-row-col"><label>Ajudante (R$)</label><input type="number" id="tf-ajudante"></div>
                            <div class="form-row-col">
                                <label>Capatazia (Taxa)</label>
                                <div style="display:flex; gap:5px;">
                                    <input type="number" id="tf-capatazia-val" placeholder="0.00" style="width:40%">
                                    <select id="tf-capatazia-tipo" style="width:60%"><option value="Por Tonelada">Por Ton</option><option value="Por Palete">Por Palete</option><option value="Por Volume">Por Vol</option></select>
                                </div>
                            </div>
                            <div class="form-row-col"><label>Movimentação Carga (R$)</label><input type="number" id="tf-movimentacao"></div>
                            <div class="form-row-col"><label>Plataforma Hidráulica (R$)</label><input type="number" id="tf-plataforma"></div>
                        </div>
                    </fieldset>

                    <fieldset class="prop-group" style="margin-top:15px; border-color:#FF3131;">
                        <legend style="color:#FF3131;">GERENCIAMENTO DE RISCO: AD VALOREM (%)</legend>
                        <p style="font-size:0.7rem; color:#888; margin-top:-5px; margin-bottom:10px;">Parâmetros para incidência sobre o Valor da NF no Módulo Outbound.</p>
                        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px;">
                            <div class="form-row-col"><label>Até R$ 999.999,99 (%)</label><input type="number" id="tf-adv-1" value="0.10" step="0.001"></div>
                            <div class="form-row-col"><label>De R$ 1M a R$ 2M (%)</label><input type="number" id="tf-adv-2" value="0.125" step="0.001"></div>
                            <div class="form-row-col"><label>Acima de R$ 2M (%)</label><input type="number" id="tf-adv-3" value="0.15" step="0.001"></div>
                        </div>
                    </fieldset>

                    <div class="props-footer" style="margin-top:20px; border:none; background:transparent; padding:0;">
                        <button class="mark-btn action apply" style="width:100%; border-color:var(--eletra-orange); color:var(--eletra-orange);" onclick="salvarTabelaFrete()"><i class="fa-solid fa-check"></i> SALVAR MATRIZ DE FRETE</button>
                    </div>
                </div>
            </div>

            <div id="tf-lista" class="tab-content">
                <div style="overflow-x: auto;">
                    <table class="data-table">
                        <thead><tr><th>Transportadora</th><th>Rota / Filial</th><th>Veículo</th><th>Custo Principal</th><th>Acessórios Base</th><th>Ações</th></tr></thead>
                        <tbody>${rows || '<tr><td colspan="6" style="text-align:center;">Nenhuma tabela cadastrada.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>

            <div id="tf-antt" class="tab-content">
                <div class="card" style="background:#111; border-left:4px solid #00D4FF;">
                    <h4 style="color:#00D4FF; margin-bottom:15px;"><i class="fa-solid fa-scale-balanced"></i> Pisos Mínimos de Frete (ANTT)</h4>
                    <p style="color:#aaa; font-size:0.8rem; margin-bottom:15px;">Tabela de referência para frete rodoviário de lotação dedicado, estabelecida pela Resolução vigente da ANTT. Valores atualizados automaticamente pela indexação do Diesel.</p>
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Categoria de Carga</th>
                                <th>Eixos</th>
                                <th>Custo de Deslocamento (R$/km)</th>
                                <th>Custo de Carga/Descarga (R$)</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr><td>Carga Geral</td><td>2 Eixos</td><td>R$ 1,35 / km</td><td>R$ 150,00</td></tr>
                            <tr><td>Carga Geral</td><td>3 Eixos (Truck)</td><td>R$ 1,75 / km</td><td>R$ 210,00</td></tr>
                            <tr><td>Carga Geral</td><td>4 Eixos (Bitruck)</td><td>R$ 2,20 / km</td><td>R$ 280,00</td></tr>
                            <tr><td>Carga Geral</td><td>5/6 Eixos (Carreta)</td><td>R$ 2,90 / km</td><td>R$ 410,00</td></tr>
                        </tbody>
                    </table>
                    <p style="color:#888; font-size:0.7rem; margin-top:10px; text-align:right;">* Valores simulados de referência. A contratação EletraEnergy atua acima do piso mínimo em todas as praças.</p>
                </div>
            </div>
        </div>
    `;
    
    if(typeof carregarDropdownFornecedores === 'function') carregarDropdownFornecedores(); 
}

async function salvarTabelaFrete() {
    const transp = document.getElementById('tf-transp').value.trim();
    const valorBase = document.getElementById('tf-valor-principal').value;

    if(!transp) { notify("Informe a transportadora.", "error"); return; }
    if(!valorBase) { notify("Obrigatório informar o custo principal.", "error"); return; }

    const payload = {
        transportadora: transp,
        modal: document.getElementById('tf-modal').value,
        origem: document.getElementById('tf-origem').value.trim(),
        regiaoDestino: document.getElementById('tf-regiao').value.trim(),
        tipoVeiculo: document.getElementById('tf-veiculo').value,
        tipoCustoPrincipal: document.getElementById('tf-tipo-custo').value,
        valorFixoOuKm: parseFloat(valorBase),
        custos: {
            diaria: parseFloat(document.getElementById('tf-diaria').value || 0),
            pernoite: parseFloat(document.getElementById('tf-pernoite').value || 0),
            ajudante: parseFloat(document.getElementById('tf-ajudante').value || 0),
            capataziaVal: parseFloat(document.getElementById('tf-capatazia-val').value || 0),
            capataziaTipo: document.getElementById('tf-capatazia-tipo').value,
            movimentacao: parseFloat(document.getElementById('tf-movimentacao').value || 0),
            plataforma: parseFloat(document.getElementById('tf-plataforma').value || 0)
        },
        adValoremParam: {
            faixa1: parseFloat(document.getElementById('tf-adv-1').value || 0),
            faixa2: parseFloat(document.getElementById('tf-adv-2').value || 0),
            faixa3: parseFloat(document.getElementById('tf-adv-3').value || 0)
        },
        user: CURRENT_USER.name,
        timestamp: new Date().toISOString()
    };

    await StorageManager.saveTabelaFrete(payload);
    notify("Condições comerciais salvas com sucesso!");
    renderTabelasFrete(document.getElementById('workspace'));
}

/* =========================================
   ROBÔ DE IMPORTAÇÃO - TOTVS PROTHEUS (BLINDADO)
   ========================================= */
function triggerCSVImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function(event) { await processarCSVProtheus(event.target.result); };
        reader.readAsText(file, 'ISO-8859-1'); 
    };
    input.click();
}

/* =========================================
   AUTOCOMPLETE DE FORNECEDORES (AGENDAMENTOS)
   ========================================= */
let fornecedoresCache = [];

async function carregarDropdownFornecedores() {
    // Busca a lista atualizada do banco de dados
    fornecedoresCache = await StorageManager.getFornecedores();
    
    // 1. Cria a lista invisível (Datalist) para pesquisa por CNPJ
    let dataListCnpj = document.getElementById('lista-fornecedores-cnpj');
    if (!dataListCnpj) {
        dataListCnpj = document.createElement('datalist');
        dataListCnpj.id = 'lista-fornecedores-cnpj';
        document.body.appendChild(dataListCnpj);
    }
    dataListCnpj.innerHTML = fornecedoresCache.map(f => `<option value="${f.cnpj}">${f.razao}</option>`).join('');
    
    // 2. Cria a lista invisível (Datalist) para pesquisa por NOME (Razão Social)
    let dataListNome = document.getElementById('lista-fornecedores-nome');
    if (!dataListNome) {
        dataListNome = document.createElement('datalist');
        dataListNome.id = 'lista-fornecedores-nome';
        document.body.appendChild(dataListNome);
    }
    dataListNome.innerHTML = fornecedoresCache.map(f => `<option value="${f.razao}">${f.cnpj}</option>`).join('');
    
    // 3. Cria a lista invisível MISTA (CNPJ e Nome) para Tabela de Fretes
    let dataListMisto = document.getElementById('lista-fornecedores-misto');
    if (!dataListMisto) {
        dataListMisto = document.createElement('datalist');
        dataListMisto.id = 'lista-fornecedores-misto';
        document.body.appendChild(dataListMisto);
    }
    dataListMisto.innerHTML = fornecedoresCache.map(f => `<option value="${f.razao}">CNPJ: ${f.cnpj}</option><option value="${f.cnpj}">${f.razao}</option>`).join('');
}

/* =========================================
   MÓDULO TRANSPORTE: VIAGENS (MOTOR DE RATING E TRACKING)
   ========================================= */
async function renderViagens(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> A carregar motor de rating e viagens...</div>';
    
    // 1. Busca Dados: Agendamentos (para achar OEs finalizadas), Tabelas de Frete e Viagens Ativas
    const [appts, tabelas, viagens] = await Promise.all([
        StorageManager.getAppointments(),
        StorageManager.getTabelasFrete(),
        StorageManager.getViagens()
    ]);

    // OEs que saíram da doca (FINALIZADO) mas ainda não viraram Viagem
    const oesAguardando = appts.filter(a => a.tipoFluxo === 'OUTBOUND' && a.status === 'FINALIZADO' && !viagens.some(v => v.idAgendamento === a.id_doc));
    
    const formatBRL = (val) => Number(val).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    // Tabela 1: OEs prontas para faturar
    let htmlOes = oesAguardando.map(a => {
        return `
        <tr style="border-bottom:1px solid #333;">
            <td><strong style="color:var(--eletra-aqua);">${a.details.oe}</strong><br><span style="font-size:0.7rem; color:#888;">NF: ${a.details.nf}</span></td>
            <td>${a.details.cliente}<br><span style="font-size:0.7rem; color:#888;">UF: ${a.details.uf || '-'}</span></td>
            <td>${a.details.transp}<br><span style="font-size:0.7rem; color:#888;">${a.details.tipoVeiculo}</span></td>
            <td>R$ ${formatBRL(a.details.valorNF || 0)}</td>
            <td style="text-align:right;">
                <button class="mark-btn action apply" style="padding:4px 8px; border-color:#39FF14; color:#39FF14;" onclick="openGeradorViagem('${a.id_doc}')"><i class="fa-solid fa-calculator"></i> CALCULAR E GERAR VIAGEM</button>
            </td>
        </tr>`;
    }).join('');

    // Tabela 2: Tracking de Viagens Ativas
    let htmlViagens = viagens.sort((a,b) => new Date(b.dataCriacao) - new Date(a.dataCriacao)).map(v => {
        let corStatus = '#aaa';
        if (v.statusTracking === 'EM TRÂNSITO') corStatus = 'var(--eletra-orange)';
        if (v.statusTracking === 'NO DESTINO') corStatus = 'var(--eletra-aqua)';
        if (v.statusTracking === 'ENTREGUE (POD)') corStatus = '#39FF14';

        return `
        <tr style="border-bottom:1px solid #333;">
            <td><strong style="color:var(--eletra-orange);">${v.oe}</strong><br><span style="font-size:0.7rem; color:#888;">NF: ${v.nf}</span></td>
            <td>${v.transportadora}</td>
            <td>${v.destinoUF}</td>
            <td>
                <span style="color:#39FF14; font-weight:bold;">R$ ${formatBRL(v.custoPrevistoTotal)}</span>
                <br><span style="font-size:0.65rem; color:#888;">Ad Valorem: R$ ${formatBRL(v.custoAdValorem)}</span>
            </td>
            <td><span style="border:1px solid ${corStatus}; color:${corStatus}; padding:2px 6px; border-radius:3px; font-size:0.7rem; font-weight:bold;">${v.statusTracking}</span></td>
            <td style="text-align:right;">
                <button class="mark-btn" style="padding:2px 8px; font-size:0.65rem;" onclick="avancarTracking('${v.id_doc}', '${v.statusTracking}')">AVANÇAR STATUS</button>
            </td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('via-aguardando')">Aguardando Viagem (<span style="color:#FF8200;">${oesAguardando.length}</span>)</button>
                <button class="tab-btn" onclick="switchTab('via-tracking')">Tracking em Tempo Real (<span style="color:#39FF14;">${viagens.length}</span>)</button>
            </div>
            
            <div id="via-aguardando" class="tab-content active">
                <p style="color:#aaa; font-size:0.8rem; margin-bottom:15px;">Ordens de Embarque carregadas na doca (Finalizadas). Selecione para calcular a estimativa de custos e enviar para trânsito.</p>
                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead><tr><th>OE / NF</th><th>Cliente / Destino</th><th>Transportadora</th><th>Valor Carga</th><th>Ação</th></tr></thead>
                        <tbody>${htmlOes || '<tr><td colspan="5" style="text-align:center; padding:20px;">Nenhuma O.E. pendente de faturamento.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>

            <div id="via-tracking" class="tab-content">
                <p style="color:#aaa; font-size:0.8rem; margin-bottom:15px;">Monitoramento da frota que já saiu da planta.</p>
                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead><tr><th>OE / NF</th><th>Transportadora</th><th>Destino</th><th>Custo Logístico (Estimado)</th><th>Status</th><th>Tracking</th></tr></thead>
                        <tbody>${htmlViagens || '<tr><td colspan="6" style="text-align:center; padding:20px;">Nenhuma viagem em curso.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>

            <div id="modal-viagem-backdrop" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.8); z-index:9998;"></div>
            <div id="viagem-modal" style="display:none; position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:var(--bg-asfalto); padding:20px; border-radius:8px; border:1px solid var(--eletra-aqua); z-index:9999; width:90%; max-width:500px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                <h3 style="color:var(--eletra-aqua); margin-bottom:15px; border-bottom:1px solid #333; padding-bottom:10px;"><i class="fa-solid fa-calculator"></i> Motor de Rating (Provisionamento)</h3>
                <input type="hidden" id="mv-id-appt">
                <input type="hidden" id="mv-valor-nf">
                
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-bottom:15px; font-size:0.8rem;">
                    <div><span style="color:#888;">Transp:</span> <strong id="mv-transp">...</strong></div>
                    <div><span style="color:#888;">UF Destino:</span> <strong id="mv-uf">...</strong></div>
                    <div><span style="color:#888;">Veículo:</span> <strong id="mv-veiculo">...</strong></div>
                    <div><span style="color:#39FF14;">Valor Carga:</span> <strong id="mv-carga-print">...</strong></div>
                </div>

                <div class="form-row-col" style="margin-bottom:15px;">
                    <label style="color:var(--eletra-orange)">Distância da Rota (Km)*</label>
                    <input type="number" id="mv-km" placeholder="Ex: 2950 (Apenas se a tabela for R$/km)">
                </div>

                <div style="background:#0B0E11; padding:15px; border-radius:4px; border:1px dashed #444; margin-bottom:15px;">
                    <button class="mark-btn action" style="width:100%; border-color:#00D4FF; color:#00D4FF; margin-bottom:10px;" onclick="simularRating()">SIMULAR PREÇO DA TARIFA</button>
                    
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:0.8rem;"><span style="color:#aaa;">Frete Base:</span> <strong id="res-frete">R$ 0,00</strong></div>
                    <div style="display:flex; justify-content:space-between; margin-bottom:5px; font-size:0.8rem;"><span style="color:#aaa;">Ad Valorem (Seguro):</span> <strong id="res-adv">R$ 0,00</strong></div>
                    <div style="display:flex; justify-content:space-between; font-size:0.9rem; margin-top:10px; padding-top:10px; border-top:1px solid #333;"><span style="color:var(--eletra-aqua); font-weight:bold;">Total Estimado:</span> <strong style="color:#39FF14;" id="res-total">R$ 0,00</strong></div>
                </div>

                <div style="display:flex; justify-content:flex-end; gap:10px;">
                    <button class="mark-btn action" onclick="document.getElementById('modal-viagem-backdrop').style.display='none'; document.getElementById('viagem-modal').style.display='none';">CANCELAR</button>
                    <button class="mark-btn action apply" style="border-color:#39FF14; color:#39FF14;" onclick="confirmarViagem()">EMITIR CT-E / INICIAR</button>
                </div>
            </div>
        </div>
    `;
    
    // Armazena dados no window para o simulador aceder
    window.viagensCacheData = { appts, tabelas };
}

window.openGeradorViagem = function(id_doc) {
    const appt = window.viagensCacheData.appts.find(a => a.id_doc === id_doc);
    if(!appt) return;

    document.getElementById('mv-id-appt').value = id_doc;
    document.getElementById('mv-valor-nf').value = appt.details.valorNF || 0;
    
    document.getElementById('mv-transp').innerText = appt.details.transp || 'Não informada';
    document.getElementById('mv-uf').innerText = appt.details.uf || 'Não informado';
    document.getElementById('mv-veiculo').innerText = appt.details.tipoVeiculo || '-';
    document.getElementById('mv-carga-print').innerText = 'R$ ' + Number(appt.details.valorNF || 0).toLocaleString('pt-BR');
    
    // Reset
    document.getElementById('mv-km').value = '';
    document.getElementById('res-frete').innerText = 'R$ 0,00';
    document.getElementById('res-adv').innerText = 'R$ 0,00';
    document.getElementById('res-total').innerText = 'R$ 0,00';
    
    // Mostra Modal
    document.getElementById('modal-viagem-backdrop').style.display = 'block';
    document.getElementById('viagem-modal').style.display = 'block';
}

window.simularRating = function() {
    const id_doc = document.getElementById('mv-id-appt').value;
    const appt = window.viagensCacheData.appts.find(a => a.id_doc === id_doc);
    const tabelas = window.viagensCacheData.tabelas;
    const km = parseFloat(document.getElementById('mv-km').value) || 0;
    const valorNf = parseFloat(document.getElementById('mv-valor-nf').value) || 0;

    // Busca a tabela da transportadora
    const tabTransp = tabelas.filter(t => t.transportadora.toUpperCase() === appt.details.transp.toUpperCase());
    if(tabTransp.length === 0) { notify("Sem contrato para esta transportadora. Utilize frete spot (0).", "error"); return; }

    // Busca aderência de Estado/Região e Veículo (Simplificado para o simulador não travar se o nome da região for livre)
    let tabelaAlvo = tabTransp[0]; // Pega a primeira como base no protótipo

    let custoBase = 0;
    if (tabelaAlvo.tipoCustoPrincipal === 'KM') {
        if(km <= 0) { notify("Insira os KMs da Rota para calcular.", "error"); return; }
        custoBase = km * (tabelaAlvo.valorFixoOuKm || 0);
    } else {
        custoBase = tabelaAlvo.valorFixoOuKm || 0;
    }

    // Regra Ad Valorem (Minuta Contrato)
    let pctAdValorem = 0;
    if (valorNf <= 999999.99) pctAdValorem = (tabelaAlvo.adValoremParam?.faixa1 || 0.10);
    else if (valorNf <= 2000000.00) pctAdValorem = (tabelaAlvo.adValoremParam?.faixa2 || 0.125);
    else pctAdValorem = (tabelaAlvo.adValoremParam?.faixa3 || 0.15);

    let valorAdValorem = valorNf * (pctAdValorem / 100);
    let custoTotal = custoBase + valorAdValorem;

    // Guarda temporariamente para salvar depois
    window.viagensCacheData.simulacaoAtual = { custoBase, valorAdValorem, custoTotal, tabelaUsada: tabelaAlvo.id_doc };

    const formatBRL = (val) => Number(val).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    document.getElementById('res-frete').innerText = 'R$ ' + formatBRL(custoBase);
    document.getElementById('res-adv').innerText = `R$ ${formatBRL(valorAdValorem)} (${pctAdValorem}%)`;
    document.getElementById('res-total').innerText = 'R$ ' + formatBRL(custoTotal);
    notify("Cálculo efetuado com sucesso!", "success");
}

window.confirmarViagem = async function() {
    const id_doc = document.getElementById('mv-id-appt').value;
    const appt = window.viagensCacheData.appts.find(a => a.id_doc === id_doc);
    const sim = window.viagensCacheData.simulacaoAtual;

    if(!sim) { notify("Faça a simulação primeiro.", "error"); return; }
    if(!confirm("Gerar Viagem e enviar camião para Trânsito?")) return;

    const viagem = {
        idAgendamento: id_doc,
        oe: appt.details.oe,
        nf: appt.details.nf,
        cliente: appt.details.cliente,
        destinoUF: appt.details.uf,
        transportadora: appt.details.transp,
        veiculo: appt.details.tipoVeiculo,
        placa: appt.details.placa,
        distanciaKm: document.getElementById('mv-km').value,
        custoPrevistoBase: sim.custoBase,
        custoAdValorem: sim.valorAdValorem,
        custoPrevistoTotal: sim.custoTotal,
        tabelaAplicadaId: sim.tabelaUsada,
        statusTracking: 'CT-E EMITIDO',
        dataCriacao: new Date().toISOString(),
        geradoPor: CURRENT_USER.name
    };

    const res = await StorageManager.saveViagem(viagem);
    if(res.success) {
        document.getElementById('modal-viagem-backdrop').style.display='none'; 
        document.getElementById('viagem-modal').style.display='none';
        notify("Camião despachado e Rastreio Iniciado!", "success");
        renderViagens(document.getElementById('workspace'));
    } else { notify(res.msg, "error"); }
}

window.avancarTracking = async function(id_doc, statusAtual) {
    const fluxos = {
        'CT-E EMITIDO': 'EM TRÂNSITO',
        'EM TRÂNSITO': 'NO DESTINO',
        'NO DESTINO': 'ENTREGUE (POD)'
    };
    
    const proximo = fluxos[statusAtual];
    if(!proximo) { notify("Esta viagem já está finalizada.", "info"); return; }
    
    if(!confirm(`Avançar etapa de rastreio para: ${proximo}?`)) return;
    
    const res = await StorageManager.updateViagemStatus(id_doc, proximo);
    if(res.success) {
        notify("Status de Rastreamento atualizado!", "success");
        renderViagens(document.getElementById('workspace'));
    }
}

window.autoFillTransp = function(inputElement, tipoBusca) {
    const valorDigitado = inputElement.value.trim().toUpperCase();
    const rawDigitado = inputElement.value.replace(/\D/g, '');
    const campoNome = document.getElementById('t-razao');
    const campoCnpj = document.getElementById('t-cnpj');
    
    let fornecedorEncontrado = null;

    if (tipoBusca === 'cnpj' && rawDigitado.length >= 11) {
        fornecedorEncontrado = fornecedoresCache.find(f => f.cnpj === rawDigitado);
        if (fornecedorEncontrado) campoNome.value = fornecedorEncontrado.razao;
    } else if (tipoBusca === 'nome' && valorDigitado.length > 3) {
        fornecedorEncontrado = fornecedoresCache.find(f => f.razao && f.razao.toUpperCase() === valorDigitado);
        if (fornecedorEncontrado) {
            campoCnpj.value = fornecedorEncontrado.cnpj;
            applyCpfCnpjMask(campoCnpj);
        }
    }
}

// Substitua a função autoFillFornecedor inteira no final do arquivo:
window.autoFillFornecedor = function(inputElement, tipoBusca) {
    const valorDigitado = inputElement.value.trim().toUpperCase();
    const rawDigitado = inputElement.value.replace(/\D/g, '');
    const campoNome = document.getElementById('input-fornecedor');
    const campoCnpj = document.getElementById('input-cnpj-fornecedor');
    campoNome.style.borderColor = "var(--border-color)";
    campoCnpj.style.borderColor = "var(--border-color)";
    let fornecedorEncontrado = null;
    if (tipoBusca === 'cnpj' && rawDigitado.length >= 11) {
        fornecedorEncontrado = fornecedoresCache.find(f => f.cnpj === rawDigitado);
        if (fornecedorEncontrado) campoNome.value = fornecedorEncontrado.razao;
    } else if (tipoBusca === 'nome' && valorDigitado.length > 3) {
        fornecedorEncontrado = fornecedoresCache.find(f => f.razao && f.razao.toUpperCase() === valorDigitado);
        if (fornecedorEncontrado) {
            campoCnpj.value = fornecedorEncontrado.cnpj;
            applyCpfCnpjMask(campoCnpj); // Aplica a máscara no CNPJ/CPF puxado
        }
    }
}

/* --- UTILITÁRIOS: MÁSCARAS --- */
window.applyCpfCnpjMask = function(input) {
    let v = input.value.replace(/\D/g, '');
    if (v.length <= 11) { // Máscara de CPF
        v = v.replace(/(\d{3})(\d)/, '$1.$2');
        v = v.replace(/(\d{3})(\d)/, '$1.$2');
        v = v.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    } else { // Máscara de CNPJ
        v = v.replace(/^(\d{2})(\d)/, '$1.$2');
        v = v.replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
        v = v.replace(/\.(\d{3})(\d)/, '.$1/$2');
        v = v.replace(/(\d{4})(\d{1,2})$/, '$1-$2');
    }
    input.value = v;
}

window.applyCepMask = function(input) {
    let v = input.value.replace(/\D/g, ''); // Remove tudo o que não é dígito
    if (v.length > 8) v = v.slice(0, 8); // Limita a 8 números
    if (v.length > 5) {
        v = v.replace(/^(\d{5})(\d)/, '$1-$2'); // Coloca o traço após o 5º dígito
    }
    input.value = v;
}

/* =========================================
   MÓDULO FINANCEIRO / TRANSPORTE: ADITIVOS E DESPESAS
   ========================================= */
async function renderAditivos(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> A carregar base financeira...</div>';
    
    const [viagens, aditivos] = await Promise.all([
        StorageManager.getViagens(),
        StorageManager.getAditivos()
    ]);

    const isGestor = ROLE_PERMISSIONS[CURRENT_USER.role].canDeleteAny;
    const formatBRL = (val) => Number(val).toLocaleString('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});

    // Filtra viagens ativas para o Dropdown (Apenas as que não foram entregues ou finalizadas financeiramente)
    const opcoesViagens = viagens
        .sort((a,b) => new Date(b.dataCriacao) - new Date(a.dataCriacao))
        .map(v => `<option value="${v.oe}|${v.transportadora}|${v.destinoUF}">OE: ${v.oe} - Transp: ${v.transportadora} (${v.destinoUF})</option>`)
        .join('');

    const pendentes = aditivos.filter(a => a.status === 'PENDENTE');
    const historico = aditivos.filter(a => a.status !== 'PENDENTE');

    // Monta Tabela de Pendentes (Tribunal de Aprovação)
    let rowsPendentes = pendentes.map(a => `
        <tr style="border-bottom:1px solid #333;">
            <td>
                <strong style="color:var(--eletra-aqua);">${a.oe}</strong><br>
                <span style="font-size:0.7rem; color:#888;">${a.transportadora}</span>
            </td>
            <td>
                <span style="color:var(--eletra-orange); font-weight:bold;">${a.natureza}</span><br>
                <span style="font-size:0.7rem; color:#aaa;">Sol: ${a.solicitante}</span>
            </td>
            <td>
                <span style="color:#39FF14; font-weight:bold;">R$ ${formatBRL(a.valorPleiteado)}</span>
            </td>
            <td><span style="font-size:0.75rem; color:#ddd; font-style:italic;">"${a.justificativa}"</span></td>
            <td style="text-align:right;">
                ${isGestor ? `
                <button class="mark-btn" style="border-color:#39FF14; color:#39FF14; padding:4px 8px; font-size:0.65rem;" onclick="julgarAditivo('${a.id_doc}', 'APROVADO')">APROVAR</button>
                <button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 8px; font-size:0.65rem; margin-top:4px;" onclick="julgarAditivo('${a.id_doc}', 'REPROVADO')">GLOSAR</button>
                ` : `<span style="font-size:0.7rem; color:#888;">Aguardando Gestão</span>`}
            </td>
        </tr>
    `).join('');

    let rowsHistorico = historico.sort((a,b) => new Date(b.dataAvaliacao) - new Date(a.dataAvaliacao)).map(a => {
        const cor = a.status === 'APROVADO' ? '#39FF14' : '#FF3131';
        return `
        <tr style="border-bottom:1px solid #333;">
            <td><strong style="color:var(--eletra-aqua);">${a.oe}</strong></td>
            <td>${a.natureza}</td>
            <td>R$ ${formatBRL(a.valorPleiteado)}</td>
            <td><span style="color:${cor}; font-weight:bold; border:1px solid ${cor}; padding:2px 5px; border-radius:3px; font-size:0.7rem;">${a.status}</span></td>
            <td><span style="font-size:0.7rem; color:#aaa;">Por: ${a.avaliadoPor}</span></td>
        </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('ad-solicitar')">Novo Pleito / Aditivo</button>
                <button class="tab-btn" onclick="switchTab('ad-pendentes')" style="color:var(--eletra-orange);">Tribunal Financeiro (${pendentes.length})</button>
                <button class="tab-btn" onclick="switchTab('ad-historico')">Histórico</button>
            </div>
            
            <div id="ad-solicitar" class="tab-content active">
                <div class="card" style="background:#111; border-color:var(--eletra-orange);">
                    <h4 style="color:var(--eletra-orange); margin-bottom:15px;"><i class="fa-solid fa-file-invoice"></i> Abertura de Chamado para Custos Extras</h4>
                    
                    <fieldset class="prop-group">
                        <legend>REFERÊNCIA DA VIAGEM</legend>
                        <div class="form-row-col">
                            <label>Selecione a Ordem de Embarque Ativa*</label>
                            <select id="ad-viagem">
                                <option value="">-- Selecione a OE em Trânsito --</option>
                                ${opcoesViagens}
                            </select>
                        </div>
                    </fieldset>

                    <fieldset class="prop-group" style="margin-top:15px;">
                        <legend>DADOS DA DESPESA / ADITIVO</legend>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div class="form-row-col">
                                <label style="color:var(--eletra-aqua);">Natureza da Despesa*</label>
                                <select id="ad-natureza">
                                    <option value="">Selecione...</option>
                                    <option value="Diária de Atraso (Estadia)">Diária de Atraso (Estadia)</option>
                                    <option value="Taxa de Capatazia / Chapa">Taxa de Capatazia / Chapa</option>
                                    <option value="Pernoite">Pernoite Extra</option>
                                    <option value="Falso Frete / Retorno">Falso Frete / Retorno Vazio</option>
                                    <option value="Outros">Outros</option>
                                </select>
                            </div>
                            <div class="form-row-col">
                                <label style="color:#39FF14;">Valor Pleiteado (R$)*</label>
                                <input type="number" id="ad-valor" placeholder="Ex: 950.00" step="0.01">
                            </div>
                        </div>
                    </fieldset>

                    <fieldset class="prop-group" style="margin-top:15px;">
                        <legend>JUSTIFICATIVA E COMPROVANTE</legend>
                        <div class="form-row-col" style="margin-bottom:10px;">
                            <label>Justificativa Técnica (Obrigatório)*</label>
                            <textarea id="ad-justificativa" rows="3" style="width:100%; padding:10px; background:#0B0E11; color:white; border:1px solid #444; border-radius:4px; resize:none;" placeholder="Descreva detalhadamente o motivo da cobrança e aponte dados do comprovativo..."></textarea>
                        </div>
                    </fieldset>

                    <div class="props-footer" style="margin-top:20px; border:none; background:transparent; padding:0;">
                        <button class="mark-btn action apply" style="width:100%; border-color:var(--eletra-orange); color:var(--eletra-orange);" onclick="salvarNovoAditivo()"><i class="fa-solid fa-paper-plane"></i> ENVIAR PARA APROVAÇÃO</button>
                    </div>
                </div>
            </div>

            <div id="ad-pendentes" class="tab-content">
                <p style="color:#aaa; font-size:0.8rem; margin-bottom:15px;">Custos pleiteados que necessitam de auditoria do Gestor Logístico antes de integrarem a fatura final.</p>
                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead><tr><th>OE / Transportadora</th><th>Natureza / Solicitante</th><th>Valor (R$)</th><th>Justificativa Apresentada</th><th>Julgamento</th></tr></thead>
                        <tbody>${rowsPendentes || '<tr><td colspan="5" style="text-align:center; padding:20px;">Nenhum pleito pendente de aprovação.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>

            <div id="ad-historico" class="tab-content">
                <div style="overflow-x:auto;">
                    <table class="data-table">
                        <thead><tr><th>O.E.</th><th>Despesa</th><th>Valor</th><th>Decisão Final</th><th>Avaliador</th></tr></thead>
                        <tbody>${rowsHistorico || '<tr><td colspan="5" style="text-align:center; padding:20px;">Nenhum histórico registado.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
}

/* =========================================
   MOTOR DE IMPORTAÇÃO E CRUZAMENTO (ERP + MATRIZ DE ENTREGAS)
   ========================================= */
window.abrirImportadorClientes = function() {
    let modal = document.getElementById('modal-import-clientes');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-import-clientes';
        modal.innerHTML = `
            <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.8); z-index:9998;"></div>
            <div style="position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:var(--bg-asfalto); padding:25px; border-radius:8px; border:1px solid var(--eletra-orange); z-index:9999; width:90%; max-width:500px; box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
                <h3 style="color:var(--eletra-orange); margin-bottom:15px;"><i class="fa-solid fa-file-csv"></i> Importação de Clientes (ERP + Matriz)</h3>
                <p style="color:#aaa; font-size:0.85rem; margin-bottom:20px;">Selecione os dois ficheiros. O sistema cruzará os dados fiscais do ERP com as regras operacionais da Matriz de Entregas.</p>
                
                <div class="form-row-col" style="margin-bottom:15px;">
                    <label style="color:var(--eletra-aqua);">1. Base do ERP (clientes_compras.csv)</label>
                    <input type="file" id="file-erp" accept=".csv" style="background:#0B0E11; border:1px solid #444; padding:8px; width:100%; color:white;">
                </div>
                
                <div class="form-row-col" style="margin-bottom:25px;">
                    <label style="color:#39FF14;">2. Matriz de Entregas (Restrições.csv)</label>
                    <input type="file" id="file-matriz" accept=".csv" style="background:#0B0E11; border:1px solid #444; padding:8px; width:100%; color:white;">
                </div>

                <div style="display:flex; justify-content:flex-end; gap:10px;">
                    <button class="mark-btn action" onclick="document.getElementById('modal-import-clientes').style.display='none'">CANCELAR</button>
                    <button class="mark-btn action apply" style="border-color:var(--eletra-orange); color:var(--eletra-orange);" onclick="processarCruzamentoCSVs()">PROCESSAR UNIFICAÇÃO</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    modal.style.display = 'block';
}

window.processarCruzamentoCSVs = async function() {
    const fileERP = document.getElementById('file-erp').files[0];
    const fileMatriz = document.getElementById('file-matriz').files[0];

    if(!fileERP) { notify("O ficheiro do ERP é obrigatório.", "error"); return; }

    notify("Iniciando leitura e cruzamento de dados. Aguarde...", "info");
    document.getElementById('modal-import-clientes').style.display = 'none';

    // Função auxiliar para ler ficheiros como Promise
    const readFileAsync = (file, encoding) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = e => reject(e);
            reader.readAsText(file, encoding);
        });
    };

    try {
        let matrixRules = [];
        
        // 1. Processa a Matriz (se enviada)
        if (fileMatriz) {
            const matText = await readFileAsync(fileMatriz, 'UTF-8');
            const matLines = matText.split('\n');
            for(let i=1; i<matLines.length; i++) {
                const cols = matLines[i].split(',');
                // Índice 1 é o Nome do Cliente no ficheiro Excel convertido
                if(cols.length > 5 && cols[1] && cols[1].trim() !== 'Cliente') {
                    matrixRules.push({
                        clienteStr: cols[1].trim().toUpperCase(),
                        carretaBau: cols[2] ? cols[2].trim() : '',
                        carretaSider: cols[3] ? cols[3].trim() : '',
                        truck: cols[4] ? cols[4].trim() : '',
                        sobreposicao: cols[5] ? cols[5].trim() : '',
                        dimensoes: cols[6] ? cols[6].trim() : '',
                        horario: cols[7] ? cols[7].trim() : '',
                        agendamento: cols[8] ? cols[8].trim() : '',
                        obs: cols[9] ? cols[9].trim() : ''
                    });
                }
            }
        }

        // 2. Processa o ERP (clientes_compras.csv)
        const erpText = await readFileAsync(fileERP, 'ISO-8859-1');
        const erpLines = erpText.split('\n');
        let count = 0;

        for(let i=1; i<erpLines.length; i++) {
            const cols = erpLines[i].split(';');
            if(cols.length < 9) continue;

            const rawCnpj = cols[0].replace(/\D/g, '');
            if(!rawCnpj) continue;

            const razao = cols[3] ? cols[3].trim().toUpperCase() : '';
            const fantasia = cols[4] ? cols[4].trim().toUpperCase() : '';

            // 3. O Cruzamento: Verifica se o nome da Matriz está contido na Razão ou Fantasia do ERP
            let restricoes = null;
            if (matrixRules.length > 0) {
                const regraMatch = matrixRules.find(r => razao.includes(r.clienteStr) || fantasia.includes(r.clienteStr));
                if (regraMatch) restricoes = regraMatch;
            }

            const payload = {
                cnpj: rawCnpj,
                razao: razao,
                fantasia: fantasia,
                cep: cols[7] ? cols[7].trim() : '',
                uf: cols[8] ? cols[8].trim() : '',
                cidade: cols[9] ? cols[9].trim() : '',
                restricoes: restricoes,
                dataAtualizacao: new Date().toISOString()
            };

            await db.collection('clientes').doc(rawCnpj).set(payload, {merge: true});
            count++;
        }

        notify(`Sucesso! ${count} Clientes processados e unidos à Matriz de Transporte.`, "success");
        if(typeof carregarDropdownClientes === 'function') carregarDropdownClientes();

    } catch(err) {
        console.error(err);
        notify("Erro ao processar os ficheiros CSV.", "error");
    }
}

/* =========================================
   MOTOR VISUAL DE NOTIFICAÇÕES (REAL-TIME)
   ========================================= */
function initNotificationSystem() {
    let bellContainer = document.getElementById('notif-bell-container');
    if(!bellContainer) {
        const headerRight = document.querySelector('header > div:last-child');
        if(headerRight) {
            const notifHTML = `
                <div id="notif-bell-container" style="position:relative; display:inline-block; margin-right:20px; cursor:pointer;" onclick="toggleNotifPanel()">
                    <i class="fa-solid fa-bell" style="font-size:1.2rem; color:var(--eletra-aqua);"></i>
                    <span id="notif-badge" style="display:none; position:absolute; top:-5px; right:-8px; background:#FF3131; color:white; border-radius:50%; font-size:0.6rem; padding:2px 5px; font-weight:bold;">0</span>
                    
                    <div id="notif-panel" style="display:none; position:absolute; top:30px; right:0; width:320px; background:var(--bg-asfalto); border:1px solid var(--eletra-orange); border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,0.8); z-index:10000; text-align:left;">
                        <div style="padding:15px; border-bottom:1px solid #333; font-weight:bold; color:var(--eletra-orange);">Centro de Alertas</div>
                        <div id="notif-list" style="max-height:300px; overflow-y:auto; padding:10px;"></div>
                    </div>
                </div>
            `;
            headerRight.insertAdjacentHTML('afterbegin', notifHTML);
        }
    }

    db.collection('notificacoes').where('userId', '==', CURRENT_USER.id).where('read', '==', false).onSnapshot(snapshot => {
        const badge = document.getElementById('notif-badge');
        const list = document.getElementById('notif-list');
        if(!badge || !list) return;

        if(snapshot.empty) {
            badge.style.display = 'none';
            list.innerHTML = '<div style="color:#888; font-size:0.8rem; text-align:center; padding:10px;">Tudo limpo por aqui.</div>';
            return;
        }

        badge.style.display = 'inline-block';
        badge.innerText = snapshot.size;

        let html = '';
        snapshot.forEach(doc => {
            const n = doc.data();
            html += `
            <div style="padding:10px; border-bottom:1px solid #333; font-size:0.75rem; color:#ddd; display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.2);">
                <div style="flex:1;">
                    <span style="color:var(--eletra-aqua); font-weight:bold; font-size:0.6rem;">${n.category || 'SISTEMA'}</span><br>
                    ${n.message}
                </div>
                <button class="mark-btn" style="border-color:#39FF14; color:#39FF14; padding:2px 6px; margin-left:10px;" onclick="markNotifRead('${doc.id}', event)" title="Lido"><i class="fa-solid fa-check"></i></button>
            </div>`;
        });
        list.innerHTML = html;
    });
}

/* =========================================
   MÓDULO: USUÁRIOS PRÓPRIOS (ENRIQUECIMENTO E MATRIZ)
   ========================================= */
window.renderProprio = async function(container) {
    if (ROLE_PERMISSIONS[CURRENT_USER.role].level < 3) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3></div>`; return;
    }
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> A carregar equipa interna...</div>';

    let usuarios = [];
    let propriosDB = {};
    try {
        const snapU = await db.collection('usuarios').get();
        snapU.forEach(d => {
            const role = String(d.data().role || d.data().perfil).toUpperCase();
            if(role !== 'TERCEIRO') usuarios.push({ id: d.id, ...d.data() });
        });
        
        // Lê o novo banco de dados "proprios"
        const snapP = await db.collection('proprios').get();
        snapP.forEach(d => { propriosDB[d.id] = d.data(); });
    } catch(e) { console.error(e); }

    window.usuariosPropriosCache = usuarios;

    let rows = usuarios.map(u => {
        const p = propriosDB[u.id] || {};
        const areasHtml = p.areas && p.areas.length > 0 ? p.areas.map(a => `<span class="badge" style="background:#333; color:var(--eletra-aqua); margin-right:4px;">${a}</span>`).join('') : '<span style="color:#FF3131;">Matriz Pendente</span>';
        
        return `
        <tr style="border-bottom:1px solid #333;">
            <td><strong>${u.name || u.nome || '-'}</strong><br><span style="font-size:0.65rem; color:#888;">${u.email}</span></td>
            <td><span class="badge ${String(u.role).toUpperCase()}">${String(u.role).toUpperCase()}</span></td>
            <td>${p.unidade || 'Não definida'}</td>
            <td>${areasHtml}</td>
            <td style="text-align:right;"><button class="mark-btn action" style="border-color:var(--eletra-orange); color:var(--eletra-orange);" onclick="abrirEditorProprio('${u.id}')">EDITAR MATRIZ</button></td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px; padding:25px;">
            <h3 style="color:var(--eletra-orange); margin-bottom:5px;"><i class="fa-solid fa-sitemap"></i> Enriquecimento de Colaboradores (Próprios)</h3>
            <p style="font-size:0.8rem; color:#aaa; margin-bottom:20px;">Defina a Unidade e as Áreas de Atuação para calibrar o roteamento do Sistema de Notificações.</p>
            
            <div id="editor-proprio" style="display:none; background:#111418; padding:20px; border:1px solid var(--eletra-orange); border-radius:8px; margin-bottom:20px;">
                <h4 style="color:var(--eletra-orange); margin-bottom:15px;" id="ep-nome">Configurar: </h4>
                <input type="hidden" id="ep-id">
                
                <div class="form-row-col" style="margin-bottom:15px; width:250px;">
                    <label>Unidade Base:</label>
                    <select id="ep-unidade" style="background:#0B0E11; border:1px solid #333; color:white; padding:8px; width:100%;">
                        <option value="Matriz (Eusébio)">Matriz (Eusébio)</option>
                        <option value="Filial">Filial</option>
                    </select>
                </div>

                <label style="font-size:0.75rem; color:#aaa;">Áreas de Atuação (Alvos de Notificação):</label>
                <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; background: #0B0E11; padding: 15px; border-radius: 6px; border: 1px solid #222; margin-bottom:15px;">
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Compras"> Compras</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Comex"> Comex</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Recebimento"> Recebimento</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Expedição"> Expedição</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="SESMT"> SESMT</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Portaria"> Portaria</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Fiscal"> Fiscal</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Fretes"> Fretes</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Monitoramento"> Monitoramento</label>
                    <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="ep-area" value="Plan Demanda"> Demanda</label>
                </div>
                
                <div style="display:flex; justify-content:flex-end; gap:10px;">
                    <button class="mark-btn action" onclick="document.getElementById('editor-proprio').style.display='none'">CANCELAR</button>
                    <button class="mark-btn action apply" style="border-color:var(--eletra-orange); color:var(--eletra-orange);" onclick="salvarProprio()">SALVAR MATRIZ</button>
                </div>
            </div>

            <div style="overflow-x:auto;">
                <table class="data-table">
                    <thead><tr><th>Colaborador</th><th>Perfil Base</th><th>Unidade</th><th>Matriz Logística</th><th>Ações</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" style="text-align:center;">Nenhum usuário próprio.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;
}

window.abrirEditorProprio = function(id) {
    const u = window.usuariosPropriosCache.find(x => x.id === id);
    if(!u) return;
    document.getElementById('ep-id').value = id;
    document.getElementById('ep-nome').innerText = `Configurar: ${u.name || u.nome}`;
    
    document.getElementById('ep-unidade').value = u.unidade || 'Matriz (Eusébio)';
    document.querySelectorAll('.ep-area').forEach(chk => { chk.checked = u.areas && u.areas.includes(chk.value); });
    
    document.getElementById('editor-proprio').style.display = 'block';
    document.getElementById('editor-proprio').scrollIntoView({behavior: "smooth"});
}

window.salvarProprio = async function() {
    const id = document.getElementById('ep-id').value;
    const unidade = document.getElementById('ep-unidade').value;
    const areasMarcadas = Array.from(document.querySelectorAll('.ep-area:checked')).map(cb => cb.value);
    
    notify("Salvando no DB Proprios...", "info");
    try {
        // Grava no NOVO DB "proprios"
        await db.collection('proprios').doc(id).set({ unidade: unidade, areas: areasMarcadas, atualizadoEm: new Date().toISOString() }, {merge: true});
        // Espelha no DB "usuarios" para o Motor de Login/Notificação não quebrar
        await db.collection('usuarios').doc(id).update({ unidade: unidade, areas: areasMarcadas });
        
        notify("Matriz atualizada!", "success");
        renderProprio(document.getElementById('workspace'));
    } catch(e) { notify("Erro ao salvar.", "error"); }
}

/* =========================================
   MÓDULO: USUÁRIOS TERCEIROS (VÍNCULO DE CNPJ)
   ========================================= */
window.renderTerceiro = async function(container) {
    if (ROLE_PERMISSIONS[CURRENT_USER.role].level < 3) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3></div>`; return;
    }
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> A carregar terceiros...</div>';

    let usuarios = [];
    let terceirosDB = {};
    try {
        const snapU = await db.collection('usuarios').get();
        snapU.forEach(d => {
            const role = String(d.data().role || d.data().perfil).toUpperCase();
            if(role === 'TERCEIRO') usuarios.push({ id: d.id, ...d.data() });
        });

        // Lê o novo banco de dados "terceiros"
        const snapT = await db.collection('terceiros').get();
        snapT.forEach(d => { terceirosDB[d.id] = d.data(); });
    } catch(e) {}

    window.usuariosTerceirosCache = usuarios;

    let rows = usuarios.map(u => {
        const t = terceirosDB[u.id] || {};
        const cnpjStr = t.cnpjVinculado ? `<strong style="color:var(--eletra-aqua);">${t.cnpjVinculado}</strong>` : '<span style="color:#FF3131;">Sem Vínculo</span>';
        const empStr = t.nomeEmpresa || '-';
        
        return `
        <tr style="border-bottom:1px solid #333;">
            <td><strong>${u.name || u.nome || '-'}</strong><br><span style="font-size:0.65rem; color:#888;">${u.email}</span></td>
            <td>${cnpjStr}</td>
            <td>${empStr}</td>
            <td style="text-align:right;"><button class="mark-btn action" style="border-color:var(--eletra-aqua); color:var(--eletra-aqua);" onclick="abrirEditorTerceiro('${u.id}')">VINCULAR EMPRESA</button></td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px; padding:25px;">
            <h3 style="color:var(--eletra-aqua); margin-bottom:5px;"><i class="fa-solid fa-truck"></i> Funil de Terceiros</h3>
            <p style="font-size:0.8rem; color:#aaa; margin-bottom:20px;">Vincule a credencial a uma Transportadora ou Fornecedor para garantir acesso restrito às cargas.</p>
            
            <div id="editor-terceiro" style="display:none; background:#111418; padding:20px; border:1px solid var(--eletra-aqua); border-radius:8px; margin-bottom:20px;">
                <h4 style="color:var(--eletra-aqua); margin-bottom:15px;" id="et-nome">Vincular: </h4>
                <input type="hidden" id="et-id">
                
                <div style="display:grid; grid-template-columns: 1fr 2fr; gap:15px;">
                    <div class="form-row-col">
                        <label>CNPJ da Empresa:</label>
                        <input type="text" id="et-cnpj" placeholder="Apenas números" style="background:#0B0E11; border:1px solid #333; color:white; padding:8px; width:100%;">
                    </div>
                    <div class="form-row-col">
                        <label>Razão Social / Fantasia:</label>
                        <input type="text" id="et-razao" style="background:#0B0E11; border:1px solid #333; color:white; padding:8px; width:100%;">
                    </div>
                </div>
                
                <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:20px;">
                    <button class="mark-btn action" onclick="document.getElementById('editor-terceiro').style.display='none'">CANCELAR</button>
                    <button class="mark-btn action apply" style="border-color:#39FF14; color:#39FF14;" onclick="salvarTerceiro()">APLICAR VÍNCULO</button>
                </div>
            </div>

            <div style="overflow-x:auto;">
                <table class="data-table">
                    <thead><tr><th>Credencial</th><th>CNPJ Vinculado</th><th>Empresa Representada</th><th>Ações</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="4" style="text-align:center;">Nenhum terceiro encontrado.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;
}

window.abrirEditorTerceiro = function(id) {
    const u = window.usuariosTerceirosCache.find(x => x.id === id);
    if(!u) return;
    document.getElementById('et-id').value = id;
    document.getElementById('et-nome').innerText = `Vincular: ${u.name || u.nome}`;
    document.getElementById('et-cnpj').value = u.cnpjVinculado || '';
    document.getElementById('et-razao').value = u.nomeEmpresa || '';
    
    document.getElementById('editor-terceiro').style.display = 'block';
    document.getElementById('editor-terceiro').scrollIntoView({behavior: "smooth"});
}

window.salvarTerceiro = async function() {
    const id = document.getElementById('et-id').value;
    const cnpj = document.getElementById('et-cnpj').value.replace(/\D/g, '');
    const razao = document.getElementById('et-razao').value.trim();
    
    if(!cnpj || !razao) { notify("CNPJ e Razão Social são obrigatórios.", "error"); return; }

    notify("Salvando no DB Terceiros...", "info");
    try {
        // Grava no NOVO DB "terceiros"
        await db.collection('terceiros').doc(id).set({ cnpjVinculado: cnpj, nomeEmpresa: razao, atualizadoEm: new Date().toISOString() }, {merge: true});
        // Espelha no DB "usuarios" para a restrição de login funcionar
        await db.collection('usuarios').doc(id).update({ cnpjVinculado: cnpj, nomeEmpresa: razao });
        
        notify("Vínculo aplicado!", "success");
        renderTerceiro(document.getElementById('workspace'));
    } catch(e) { notify("Erro ao salvar.", "error"); }
}

/* =========================================
   MÓDULO: CRUD PRODUTOS
   ========================================= */
async function renderProduto(container) {
    if (ROLE_PERMISSIONS[CURRENT_USER.role].level < 3) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3></div>`; return;
    }
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> A carregar portefólio...</div>';
    
    let produtos = [];
    try { const snap = await db.collection('produtos').get(); produtos = snap.docs.map(doc => ({ id_doc: doc.id, ...doc.data() })); } catch(e) {}
    
    let rows = produtos.map(p => `
        <tr style="border-bottom:1px solid #333;">
            <td><strong style="color:var(--eletra-aqua);">${p.codigo}</strong></td>
            <td>${p.descricao}<br><span style="font-size:0.65rem; color:#888;">Cat: ${p.categoria} | NCM: ${p.ncm || '-'}</span></td>
            <td>${p.pesoKg} kg</td>
            <td>${p.cubagem} m³</td>
            <td style="text-align:right;"><button class="mark-btn" style="border-color:#FF3131; color:#FF3131; padding:4px 8px;" onclick="deletarProduto('${p.id_doc}')"><i class="fa-solid fa-trash"></i></button></td>
        </tr>
    `).join('');

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('prod-geral')">Cadastro de Produto</button>
                <button class="tab-btn" onclick="switchTab('prod-lista')">Catálogo (${produtos.length})</button>
            </div>
            
            <div id="prod-geral" class="tab-content active">
                <fieldset class="prop-group">
                    <legend>DADOS DO MATERIAL (SKU)</legend>
                    <div style="display: grid; grid-template-columns: 1fr 3fr; gap: 10px;">
                        <div class="form-row-col"><label>Código ERP (SKU)*</label><input type="text" id="p-cod"></div>
                        <div class="form-row-col"><label>Descrição do Produto*</label><input type="text" id="p-desc" placeholder="Nome técnico..."></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top:10px;">
                        <div class="form-row-col"><label>Categoria</label><select id="p-cat"><option value="Matéria Prima">Matéria Prima</option><option value="Produto Acabado">Produto Acabado</option><option value="Embalagem">Embalagem</option></select></div>
                        <div class="form-row-col"><label>NCM</label><input type="text" id="p-ncm"></div>
                    </div>
                </fieldset>

                <fieldset class="prop-group" style="margin-top:15px;">
                    <legend>DADOS LOGÍSTICOS E DIMENSIONAIS</legend>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div class="form-row-col"><label style="color:var(--eletra-orange);">Peso Bruto (Kg)*</label><input type="number" id="p-peso" step="0.01"></div>
                        <div class="form-row-col"><label style="color:var(--eletra-aqua);">Cubagem Un. (m³)*</label><input type="number" id="p-cubagem" step="0.001" placeholder="Ex: 0.05"></div>
                    </div>
                </fieldset>

                <div class="props-footer" style="margin-top:20px; border:none; padding:0; background:transparent;">
                    <button class="mark-btn action apply" style="width:100%; border-color:#39FF14; color:#39FF14;" onclick="salvarProduto()">SALVAR PRODUTO</button>
                </div>
            </div>

            <div id="prod-lista" class="tab-content">
                <table class="data-table">
                    <thead><tr><th>SKU</th><th>Descrição</th><th>Peso/Un</th><th>Cubagem/Un</th><th>Ações</th></tr></thead>
                    <tbody>${rows || '<tr><td colspan="5" style="text-align:center;">Nenhum produto registado.</td></tr>'}</tbody>
                </table>
            </div>
        </div>
    `;
}

/* =========================================
   MÓDULO FINANCEIRO: MURAL DE FRETES (BID)
   ========================================= */
window.renderBidSpot = async function(container) {
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Atualizando Mural de Cargas...</div>';
    
    const isTerceiro = ROLE_PERMISSIONS[CURRENT_USER.role].level === 1;
    let bids = [];
    let clientesHtml = '';
    
    try {
        let query = db.collection('bids').orderBy('dataCriacao', 'desc');
        if (isTerceiro) query = query.where('status', '==', 'ABERTA'); 
        const snap = await query.get();
        bids = snap.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));

        if (!isTerceiro) {
            const snapC = await db.collection('clientes').get();
            window.clientesCache = snapC.docs.map(doc => doc.data());
            // Datalist formatado para mostrar Matriz e Filiais separadas
            clientesHtml = `<datalist id="lista-clientes-bid">` + 
                window.clientesCache.map(c => `<option value="${c.cnpj} - ${c.nomeFantasia || c.razaoSocial || ''} (${(c.cidade || '')} - ${(c.uf || '')})">`).join('') +
            `</datalist>`;
        }
    } catch(e) { console.error("Erro ao buscar dados do BID:", e); }

    let muralHtml = bids.map(b => {
        let acoesHtml = '';
        if (b.status === 'ABERTA') {
            if (isTerceiro) {
                acoesHtml = `<button class="mark-btn action apply" style="border-color:#39FF14; color:#39FF14; width:100%;" onclick="abrirModalLance('${b.id_doc}', '${b.origem}', '${b.entregas.length} Destino(s)')">ENVIAR LANCE DE FRETE</button>`;
            } else {
                acoesHtml = `<button class="mark-btn action" style="border-color:var(--eletra-aqua); color:var(--eletra-aqua); width:100%;" onclick="analisarLances('${b.id_doc}')">VER LANCES / APROVAR</button>`;
            }
        } else {
            acoesHtml = `<div style="text-align:center; color:#888; padding:8px; border:1px solid #333; border-radius:4px;">FECHADA - Vencedor: ${b.vencedorNome || '-'}</div>`;
        }

        let entregasHtml = (b.entregas || []).map((e, idx) => `
            <div style="font-size:0.75rem; border-left:2px solid var(--eletra-aqua); padding-left:8px; margin-bottom:8px;">
                <span style="color:var(--eletra-aqua); font-weight:bold;">Destino ${idx+1}:</span> ${e.cliente} <br>
                <span style="color:#888;">${e.endereco}</span><br>
                <span style="color:#ddd; font-weight:600;">Peso: ${e.peso}t | Paletes: ${e.paletes} | NF(s): ${e.nfs || '-'}</span><br>
                <span style="color:#aaa;">Valor Mercadoria: R$ ${Number(e.valor).toLocaleString('pt-BR', {minimumFractionDigits:2})}</span>
            </div>
        `).join('');

        const veiculosStr = b.veiculos ? b.veiculos.join(', ') : 'Qualquer';
        const tagSobreposicao = b.sobreposicao === 'NÃO' 
            ? `<span class="badge" style="background:#FF3131; color:white; font-size:0.65rem; position:absolute; top:10px; right:75px;"><i class="fa-solid fa-ban"></i> S/ SOBREPOSIÇÃO</span>` 
            : '';

        return `
        <div class="card" style="border-left: 4px solid ${b.status === 'ABERTA' ? '#39FF14' : '#FF3131'}; position:relative;">
            <div style="position:absolute; top:10px; right:15px; font-size:0.7rem; color:${b.status === 'ABERTA' ? '#39FF14' : '#FF3131'}; font-weight:bold;">${b.status}</div>
            ${tagSobreposicao}
            
            <h4 style="color:var(--eletra-orange); margin-bottom:5px;"><i class="fa-solid fa-map-pin"></i> Origem: ${b.origem}</h4>
            <div style="font-size:0.8rem; margin-bottom:15px; color:#aaa;">Coleta: ${b.dataColeta} às ${b.horaColeta}</div>
            
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; font-size:0.8rem; margin-bottom:15px; background:#0B0E11; padding:10px; border-radius:4px; border:1px solid #333;">
                <div><span style="color:#888;">Tot. Peso:</span> ${b.pesoTotal} Ton</div>
                <div><span style="color:#888;">Tot. Paletes:</span> ${b.paletesTotal} un</div>
                <div style="grid-column: span 2"><span style="color:#888;">Tot. Valor:</span> R$ ${Number(b.valorTotal).toLocaleString('pt-BR', {minimumFractionDigits:2})}</div>
                <div style="grid-column: span 2"><span style="color:var(--eletra-aqua); font-weight:bold;">Veículos Livres:</span> ${veiculosStr}</div>
            </div>
            
            <div style="margin-bottom:15px;">
                <h5 style="color:#aaa; border-bottom:1px solid #333; margin-bottom:10px; padding-bottom:3px;">Plano de Carga (Consolidação)</h5>
                ${entregasHtml}
            </div>

            ${acoesHtml}
        </div>`;
    }).join('');

    let painelCriacao = '';
    if (!isTerceiro) {
        painelCriacao = `
        ${clientesHtml}
        <fieldset class="prop-group" style="margin-bottom:20px; border-color:var(--eletra-orange);">
            <legend style="color:var(--eletra-orange);">Publicar Carga para Cotação</legend>
            
            <div style="display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px; margin-bottom:20px;">
                <div class="form-row-col">
                    <label>Origem da Coleta*</label>
                    <select id="bid-origem" style="background:#0B0E11; border:1px solid #333; color:white; padding:8px;">
                        <option value="Eletra Matriz (Itaitinga)">Eletra Matriz (Itaitinga)</option>
                        <option value="Livoltek CD (Fortaleza)">Livoltek CD (Fortaleza)</option>
                    </select>
                </div>
                <div class="form-row-col"><label>Data Coleta*</label><input type="date" id="bid-data"></div>
                <div class="form-row-col"><label>Horário Est.*</label><input type="time" id="bid-hora"></div>
            </div>

            <div style="border: 1px solid #333; padding:15px; border-radius:4px; margin-bottom:15px; background:rgba(0,0,0,0.2);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
                    <label style="color:var(--eletra-aqua); font-weight:bold; margin:0;"><i class="fa-solid fa-boxes-stacked"></i> Consolidação de Carga (Até 10 Entregas)</label>
                    <div style="font-size:0.75rem; background:#111418; padding:5px 10px; border-radius:4px; border:1px solid var(--eletra-aqua);">
                        Totais: <strong id="bid-peso-total">0.00</strong>t | <strong id="bid-paletes-total">0</strong> Pal. | R$ <strong id="bid-valor-total">0,00</strong>
                    </div>
                </div>
                
                <div id="bid-entregas-container">
                    <div class="bid-entrega-row" style="padding: 15px; background: rgba(0,0,0,0.4); border: 1px solid #444; border-radius: 4px; margin-bottom:10px;">
                        <h5 style="color:var(--eletra-orange); margin-bottom:10px;">Destino 1</h5>
                        
                        <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-bottom: 10px;">
                            <input type="text" list="lista-clientes-bid" class="bid-cliente" placeholder="Buscar Cliente Cadastrado (CNPJ/Razão)*" oninput="selecionarClienteBid(this); recalcularLogisticaBid()">
                            <div style="display:flex; gap:5px;">
                                <input type="text" class="bid-cep" placeholder="CEP" style="width:100%;" onblur="buscarCepBid(this)">
                                <button type="button" class="mark-btn" style="padding:0 15px; border-color:var(--eletra-aqua); color:var(--eletra-aqua);" onclick="buscarCepBid(this)" title="Buscar Endereço do CEP"><i class="fa-solid fa-magnifying-glass"></i></button>
                            </div>
                        </div>

                        <div style="display: grid; grid-template-columns: 2fr 1fr 1fr 0.5fr; gap: 10px; margin-bottom: 10px;">
                            <input type="text" class="bid-rua" placeholder="Logradouro / Número*">
                            <input type="text" class="bid-bairro" placeholder="Bairro*">
                            <input type="text" class="bid-cidade" placeholder="Cidade*">
                            <input type="text" class="bid-uf" placeholder="UF*" maxlength="2">
                        </div>

                        <div style="display: grid; grid-template-columns: 1fr 1fr 1.5fr 2fr; gap: 10px;">
                            <input type="number" class="bid-peso-row" placeholder="Peso (Ton)*" step="0.01" oninput="recalcularTotaisBid()">
                            <input type="number" class="bid-paletes-row" placeholder="Paletes (Un)*" oninput="recalcularTotaisBid()">
                            <input type="number" class="bid-valor-row" placeholder="Valor NF (R$)*" step="0.01" oninput="recalcularTotaisBid()">
                            <input type="text" class="bid-nfs-row" placeholder="NFs (ex: 123, 456)*" title="Pode usar vírgula ou ponto-e-vírgula">
                        </div>
                    </div>
                </div>
                <button class="mark-btn" style="border-color:#555; color:#ccc; margin-top:5px; font-size:0.75rem;" onclick="addBidEntrega()"><i class="fa-solid fa-plus"></i> ADICIONAR NOVO DESTINO</button>
            </div>

            <div class="form-row-col" style="margin-bottom:15px; padding:15px; background:#111418; border:1px dashed var(--eletra-orange); border-radius:6px;">
                <label style="color:var(--eletra-orange); font-weight:bold;"><i class="fa-solid fa-robot"></i> INTELIGÊNCIA LOGÍSTICA (Restrições Cruzadas)</label>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
                    <div id="bid-veiculos-calculados">
                        <span style="color:#888; font-size:0.8rem;">Aguardando clientes para cruzar restrições de frota...</span>
                    </div>
                    <div id="bid-tags-logistica"></div>
                </div>
                <input type="hidden" id="bid-veiculos-hidden" value="Carreta Baú,Carreta Sider,Truck,Toco,VUC,Fiorino/Van">
                <input type="hidden" id="bid-sobreposicao-hidden" value="SIM">
            </div>

            <button class="mark-btn action apply" style="margin-top:5px; border-color:#FF8200; color:#FF8200; width:100%;" onclick="publicarBid()">PUBLICAR NO MURAL (NOTIFICAR TERCEIROS)</button>
        </fieldset>`;
    }

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:600px; padding:20px;">
            <h2 style="color:white; margin-bottom:20px;"><i class="fa-solid fa-gavel"></i> Mural de Cotações</h2>
            ${painelCriacao}
            <h3 style="color:var(--eletra-aqua); margin-bottom:15px; border-bottom:1px solid #333; padding-bottom:5px;">Cargas Disponíveis no Mercado</h3>
            <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); gap:20px;">
                ${muralHtml || '<div style="color:#888;">Nenhuma carga no mural no momento.</div>'}
            </div>
        </div>
    `;
    if(!isTerceiro) recalcularLogisticaBid(); 
}

// AUTOCOMPLETAR CLIENTE SELECIONADO
window.selecionarClienteBid = function(input) {
    const val = input.value.trim().toLowerCase();
    if (!val) return;
    
    const cnpjMatch = val.match(/[\d\.\-\/]+/);
    const termoBusca = cnpjMatch ? cnpjMatch[0] : val;

    const cli = (window.clientesCache || []).find(c => 
        (c.razaoSocial && c.razaoSocial.toLowerCase().includes(termoBusca)) || 
        (c.cnpj && c.cnpj.includes(termoBusca))
    );

    if (cli) {
        const row = input.closest('.bid-entrega-row');
        row.querySelector('.bid-cep').value = cli.cep || '';
        row.querySelector('.bid-rua').value = cli.endereco || '';
        row.querySelector('.bid-bairro').value = cli.bairro || '';
        row.querySelector('.bid-cidade').value = cli.cidade || '';
        row.querySelector('.bid-uf').value = cli.uf || '';
        notify("Endereço do cliente importado para a rota!", "success");
    }
}

// BUSCA VIA CEP (INDIVIDUAL POR LINHA DE ENTREGA)
window.buscarCepBid = async function(el) {
    // Identifica se clicou no botão ou saiu do input
    let cepInput = el.tagName === 'BUTTON' ? el.previousElementSibling : el;
    let cep = cepInput.value.replace(/\D/g, '');
    if (cep.length !== 8) return;
    
    const row = cepInput.closest('.bid-entrega-row');
    row.querySelector('.bid-rua').value = "Buscando satélite...";
    
    try {
        let response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        let data = await response.json();
        if (!data.erro) {
            row.querySelector('.bid-rua').value = data.logradouro || '';
            row.querySelector('.bid-bairro').value = data.bairro || '';
            row.querySelector('.bid-cidade').value = data.localidade || '';
            row.querySelector('.bid-uf').value = data.uf || '';
            notify("CEP localizado e preenchido.", "success");
        } else {
            row.querySelector('.bid-rua').value = "";
            notify("CEP não encontrado.", "error");
        }
    } catch (e) { 
        row.querySelector('.bid-rua').value = ""; 
        console.error(e);
    }
}

window.recalcularTotaisBid = function() {
    let tPeso = 0, tPaletes = 0, tValor = 0;
    document.querySelectorAll('.bid-peso-row').forEach(i => tPeso += parseFloat(i.value) || 0);
    document.querySelectorAll('.bid-paletes-row').forEach(i => tPaletes += parseInt(i.value) || 0);
    document.querySelectorAll('.bid-valor-row').forEach(i => tValor += parseFloat(i.value) || 0);
    
    document.getElementById('bid-peso-total').innerText = tPeso.toFixed(2);
    document.getElementById('bid-paletes-total').innerText = tPaletes;
    document.getElementById('bid-valor-total').innerText = tValor.toLocaleString('pt-BR', {minimumFractionDigits:2});
}

window.addBidEntrega = function() {
    const container = document.getElementById('bid-entregas-container');
    const count = container.querySelectorAll('.bid-entrega-row').length;
    if(count >= 10) { notify("Limite máximo de 10 entregas atingido.", "error"); return; }
    
    const div = document.createElement('div');
    div.className = 'bid-entrega-row';
    div.style.cssText = "padding: 15px; background: rgba(0,0,0,0.4); border: 1px solid #444; border-radius: 4px; margin-bottom:10px;";
    div.innerHTML = `
        <h5 style="color:var(--eletra-orange); margin-bottom:10px;">Destino ${count+1}</h5>
        
        <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-bottom: 10px;">
            <input type="text" list="lista-clientes-bid" class="bid-cliente" placeholder="Buscar Cliente (CNPJ/Razão)*" oninput="selecionarClienteBid(this); recalcularLogisticaBid()">
            <div style="display:flex; gap:5px;">
                <input type="text" class="bid-cep" placeholder="CEP" style="width:100%;" onblur="buscarCepBid(this)">
                <button type="button" class="mark-btn" style="padding:0 15px; border-color:var(--eletra-aqua); color:var(--eletra-aqua);" onclick="buscarCepBid(this)" title="Buscar Endereço do CEP"><i class="fa-solid fa-magnifying-glass"></i></button>
            </div>
        </div>

        <div style="display: grid; grid-template-columns: 2fr 1fr 1fr 0.5fr; gap: 10px; margin-bottom: 10px;">
            <input type="text" class="bid-rua" placeholder="Logradouro / Número*">
            <input type="text" class="bid-bairro" placeholder="Bairro*">
            <input type="text" class="bid-cidade" placeholder="Cidade*">
            <input type="text" class="bid-uf" placeholder="UF*" maxlength="2">
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr 1.5fr 2fr; gap: 10px;">
            <input type="number" class="bid-peso-row" placeholder="Peso (Ton)*" step="0.01" oninput="recalcularTotaisBid()">
            <input type="number" class="bid-paletes-row" placeholder="Paletes (Un)*" oninput="recalcularTotaisBid()">
            <input type="number" class="bid-valor-row" placeholder="Valor NF (R$)*" step="0.01" oninput="recalcularTotaisBid()">
            <input type="text" class="bid-nfs-row" placeholder="NFs (ex: 123, 456)*">
        </div>
    `;
    container.appendChild(div);
}

window.recalcularLogisticaBid = function() {
    const todosVeiculos = ['Carreta Baú', 'Carreta Sider', 'Truck', 'Toco', 'VUC', 'Fiorino/Van'];
    let veiculosPermitidos = [...todosVeiculos];
    let aceitaSobreposicao = true;
    let clientesReconhecidos = 0;

    const inputs = document.querySelectorAll('.bid-cliente');
    inputs.forEach(input => {
        const val = input.value.trim().toLowerCase();
        if (!val) return;
        
        const cnpjMatch = val.match(/[\d\.\-\/]+/);
        const termoBusca = cnpjMatch ? cnpjMatch[0] : val;

        const cli = (window.clientesCache || []).find(c => 
            (c.razaoSocial && c.razaoSocial.toLowerCase().includes(termoBusca)) || 
            (c.cnpj && c.cnpj.includes(termoBusca))
        );

        if (cli) {
            clientesReconhecidos++;
            if (cli.veiculosPermitidos && Array.isArray(cli.veiculosPermitidos) && cli.veiculosPermitidos.length > 0) {
                veiculosPermitidos = veiculosPermitidos.filter(v => cli.veiculosPermitidos.includes(v));
            }
            if (cli.aceitaSobreposicao === false || cli.aceitaSobreposicao === 'NÃO' || cli.sobreposicao === 'NÃO') {
                aceitaSobreposicao = false;
            }
        }
    });

    const containerV = document.getElementById('bid-veiculos-calculados');
    const tagContainer = document.getElementById('bid-tags-logistica');
    const hidVeic = document.getElementById('bid-veiculos-hidden');
    const hidSobre = document.getElementById('bid-sobreposicao-hidden');

    if (!containerV) return;

    if (clientesReconhecidos === 0) {
        containerV.innerHTML = todosVeiculos.map(v => `<span class="badge" style="background:#333; color:#aaa; margin-right:5px; margin-bottom:5px;">${v}</span>`).join('');
        hidVeic.value = todosVeiculos.join(',');
        hidSobre.value = 'SIM';
        tagContainer.innerHTML = '';
    } else if (veiculosPermitidos.length === 0) {
        containerV.innerHTML = `<span style="color:#FF3131; font-weight:bold;"><i class="fa-solid fa-triangle-exclamation"></i> Incompatibilidade de Frota!</span>`;
        hidVeic.value = 'ERRO';
    } else {
        containerV.innerHTML = veiculosPermitidos.map(v => `<span class="badge" style="background:#111418; border:1px solid #39FF14; color:#39FF14; margin-right:5px; margin-bottom:5px;">${v} <i class="fa-solid fa-check"></i></span>`).join('');
        hidVeic.value = veiculosPermitidos.join(',');
    }

    if (!aceitaSobreposicao) {
        tagContainer.innerHTML = `<span class="badge" style="background:#FF3131; color:white; font-size:0.75rem;"><i class="fa-solid fa-ban"></i> S/ SOBREPOSIÇÃO</span>`;
        hidSobre.value = 'NÃO';
    } else if (clientesReconhecidos > 0) {
        tagContainer.innerHTML = `<span class="badge" style="background:#333; color:#aaa; font-size:0.75rem;">Aceita Sobreposição</span>`;
        hidSobre.value = 'SIM';
    }
}

window.publicarBid = async function() {
    const origem = document.getElementById('bid-origem').value;
    const data = document.getElementById('bid-data').value;
    const hora = document.getElementById('bid-hora').value;
    
    const veiculosCalc = document.getElementById('bid-veiculos-hidden').value;
    const sobreposicaoCalc = document.getElementById('bid-sobreposicao-hidden').value;
    
    if (veiculosCalc === 'ERRO') {
        notify("Não é possível publicar: Incompatibilidade de veículos na rota.", "error"); return;
    }
    const veiculos = veiculosCalc.split(',');
    
    const entregas = [];
    let pesoTotal = 0, paletesTotal = 0, valorTotal = 0;

    document.querySelectorAll('.bid-entrega-row').forEach(row => {
        const cliente = row.querySelector('.bid-cliente').value.trim();
        
        // Montagem do Endereço Completo
        const rua = row.querySelector('.bid-rua').value.trim();
        const bairro = row.querySelector('.bid-bairro').value.trim();
        const cidade = row.querySelector('.bid-cidade').value.trim();
        const uf = row.querySelector('.bid-uf').value.trim();
        const cep = row.querySelector('.bid-cep').value.trim();
        let endArr = [];
        if(rua) endArr.push(rua);
        if(bairro) endArr.push(bairro);
        if(cidade) endArr.push(cidade);
        if(uf) endArr.push(uf);
        if(cep) endArr.push(`CEP: ${cep}`);
        const enderecoCompleto = endArr.join(', ');

        const peso = parseFloat(row.querySelector('.bid-peso-row').value) || 0;
        const paletes = parseInt(row.querySelector('.bid-paletes-row').value) || 0;
        const valor = parseFloat(row.querySelector('.bid-valor-row').value) || 0;
        
        // Tratamento da String de Notas Fiscais (Converte vírgula para Ponto e Vírgula)
        let nfsRaw = row.querySelector('.bid-nfs-row').value.trim();
        let nfsFormatado = nfsRaw.replace(/,/g, ';').split(';').map(n => n.trim()).filter(n=>n).join('; ');

        if(cliente && enderecoCompleto && peso && paletes && valor && nfsFormatado) {
            entregas.push({ cliente, endereco: enderecoCompleto, peso, paletes, valor, nfs: nfsFormatado });
            pesoTotal += peso; paletesTotal += paletes; valorTotal += valor;
        }
    });

    if(!data || !hora || entregas.length === 0) { 
        notify("Preencha a data e garanta que todas as linhas de entrega têm os dados completos (incluindo NFs).", "error"); 
        return; 
    }

    const payload = {
        origem, dataColeta: data, horaColeta: hora, 
        pesoTotal, paletesTotal, valorTotal, 
        veiculos, sobreposicao: sobreposicaoCalc, entregas,
        status: 'ABERTA', criadoPor: CURRENT_USER.id, dataCriacao: new Date().toISOString()
    };

    try {
        await db.collection('bids').add(payload);
        await StorageManager.dispatchSmartNotification(`NOVA CARGA NO MURAL: Coleta em ${origem}`, 'BID_MURAL', 'NOVA_OFERTA', CURRENT_USER.id);
        notify("Oferta publicada no Mural!", "success");
        renderBidSpot(document.getElementById('workspace'));
    } catch(e) { notify("Erro ao publicar.", "error"); console.error(e); }
}

// Funções de Lance mantidas
window.abrirModalLance = function(bidId, origem, infoDestino) {
    const valor = prompt(`DAR LANCE PARA A CARGA:\n${origem} -> ${infoDestino}\n\nInforme o valor do frete (R$):`);
    if (!valor || isNaN(valor.replace(',','.'))) return;
    const sla = prompt(`Qual o prazo de entrega (SLA em dias) para esta carga?`);
    if (!sla) return;
    if (confirm(`Confirmar lance de R$ ${valor} com SLA de ${sla} dias?`)) { submeterLance(bidId, parseFloat(valor.replace(',','.')), sla); }
}

async function submeterLance(bidId, valor, sla) {
    try {
        const userDoc = await db.collection('usuarios').doc(CURRENT_USER.id).get();
        const transportadoraNome = userDoc.data().nomeEmpresa || CURRENT_USER.name;
        await db.collection('bid_lances').add({
            bidId, transpId: CURRENT_USER.id, transpNome: transportadoraNome,
            valorR$: valor, slaDias: sla, dataLance: new Date().toISOString()
        });
        notify("Lance submetido! O cliente avaliará em breve.", "success");
        await StorageManager.dispatchSmartNotification(`Novo lance recebido. Empresa: ${transportadoraNome}.`, 'BID_INTERNO', 'NOVO_LANCE', null);
    } catch(e) { notify("Erro ao submeter lance.", "error"); }
}

window.analisarLances = async function(bidId) {
    try {
        const snap = await db.collection('bid_lances').where('bidId', '==', bidId).get();
        if (snap.empty) { notify("Nenhum lance recebido ainda.", "info"); return; }
        let lances = snap.docs.map(d => ({ id_lance: d.id, ...d.data() }));
        lances.sort((a, b) => a.valorR$ - b.valorR$);

        let rankingText = "RANKING DE LANCES (Do menor para o maior):\n\n";
        lances.forEach((l, i) => { rankingText += `${i+1}º Lugar: ${l.transpNome}\n   Valor: R$ ${l.valorR$.toLocaleString('pt-BR')} | SLA: ${l.slaDias} dias\n\n`; });
        rankingText += "Deseja APROVAR o lance em 1º lugar?";
        if (confirm(rankingText)) { aprovarBid(bidId, lances[0]); }
    } catch(e) { console.error(e); }
}

async function aprovarBid(bidId, lanceVencedor) {
    try {
        await db.collection('bids').doc(bidId).update({
            status: 'FECHADA', vencedorId: lanceVencedor.transpId,
            vencedorNome: lanceVencedor.transpNome, valorFechado: lanceVencedor.valorR$
        });
        await StorageManager.dispatchSmartNotification(`Sua empresa venceu o BID! Valor Aprovado: R$ ${lanceVencedor.valorR$}. Prepare a coleta.`, 'GERAL', 'BID_VENCEDOR', lanceVencedor.transpId);
        notify("Oferta fechada com sucesso! Vencedor notificado.", "success");
        renderBidSpot(document.getElementById('workspace'));
    } catch(e) { notify("Erro ao aprovar.", "error"); }
}

window.salvarProduto = async function() {
    const cod = document.getElementById('p-cod').value.trim();
    const desc = document.getElementById('p-desc').value.trim();
    const peso = document.getElementById('p-peso').value;
    const cub = document.getElementById('p-cubagem').value;
    
    if(!cod || !desc || !peso || !cub) { notify("Código, Descrição, Peso e Cubagem são obrigatórios.", "error"); return; }

    const payload = { codigo: cod, descricao: desc, categoria: document.getElementById('p-cat').value, ncm: document.getElementById('p-ncm').value, pesoKg: parseFloat(peso), cubagem: parseFloat(cub), timestamp: new Date().toISOString() };
    
    await db.collection('produtos').add(payload);
    notify("Produto catalogado!");
    renderProduto(document.getElementById('workspace'));
}

window.deletarProduto = async function(id) {
    if(!confirm("Apagar produto da base?")) return;
    await db.collection('produtos').doc(id).delete(); notify("Removido."); renderProduto(document.getElementById('workspace'));
}

window.toggleNotifPanel = function() {
    const p = document.getElementById('notif-panel');
    if(p) p.style.display = p.style.display === 'none' ? 'block' : 'none';
}

window.markNotifRead = async function(id, event) {
    event.stopPropagation();
    await db.collection('notificacoes').doc(id).update({read: true});
}

// --- FUNÇÕES AUXILIARES DE FORMATAÇÃO E BUSCA ---
window.formatarCnpjCpf = function(v) {
    if (!v) return '-';
    v = v.replace(/\D/g, "");
    if (v.length === 11) return v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
    if (v.length === 14) return v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
    return v;
}

window.buscarCEP = async function() {
    let cep = document.getElementById('c-cep').value.replace(/\D/g, '');
    if (cep.length !== 8) return;
    
    document.getElementById('c-endereco').value = "Buscando...";
    try {
        let response = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        let data = await response.json();
        if (!data.erro) {
            document.getElementById('c-endereco').value = data.logradouro || '';
            document.getElementById('c-bairro').value = data.bairro || '';
            document.getElementById('c-cidade').value = data.localidade || '';
            document.getElementById('c-uf').value = data.uf || '';
            gerarEnderecoCompleto();
            notify("Endereço preenchido automaticamente!", "success");
        } else {
            document.getElementById('c-endereco').value = "";
            notify("CEP não encontrado.", "error");
        }
    } catch (e) { console.error(e); document.getElementById('c-endereco').value = ""; }
}

/* =========================================
   MÓDULO DE CADASTROS: CLIENTES (ATUALIZADO)
   ========================================= */
window.renderCliente = async function(container) {
    if (ROLE_PERMISSIONS[CURRENT_USER.role].level < 3) {
        container.innerHTML = `<div class="card"><h3 style="color:#FF3131">Acesso Restrito</h3></div>`; return;
    }
    container.innerHTML = '<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Carregando base de clientes...</div>';

    let clientes = [];
    try {
        const snap = await db.collection('clientes').get();
        clientes = snap.docs.map(doc => ({ id_doc: doc.id, ...doc.data() }));
    } catch(e) { console.error("Erro ao buscar clientes:", e); }

    window.clientesCacheEdit = clientes; // CACHE SEGURO: Fica tudo na memória do JS, e não no HTML.

    // FUNÇÃO INTERNA: Renderizador Rápido de Linhas
    window.gerarLinhasTabelaClientes = function(lista) {
        if(lista.length === 0) return '<tr><td colspan="5" style="text-align:center; padding:15px;">Nenhum cliente encontrado na busca.</td></tr>';
        
        return lista.map(c => {
            const matrizStatus = (c.veiculosPermitidos && c.veiculosPermitidos.length > 0) 
                ? `<span style="color:#39FF14; font-size:0.7rem;"><i class="fa-solid fa-check-circle"></i> Matriz OK</span>` 
                : `<span style="color:#FF3131; font-size:0.7rem;"><i class="fa-solid fa-triangle-exclamation"></i> Pendente</span>`;
            
            let docFormatado = c.cnpj || '-';
            if(docFormatado.length === 11) docFormatado = docFormatado.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
            else if(docFormatado.length === 14) docFormatado = docFormatado.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");

            return `,
            <tr style="border-bottom:1px solid #333;">
                <td><strong>${docFormatado}</strong></td>
                <td><strong style="color:var(--eletra-aqua);">${c.nomeFantasia || '-'}</strong><br><span style="font-size:0.75rem; color:#888;">${c.razaoSocial || '-'}</span></td>
                <td>${c.cidade || '-'} / ${c.uf || '-'}</td>
                <td>${matrizStatus}</td>
                <td style="text-align:right;">
                    <button class="mark-btn action" style="border-color:var(--eletra-orange); color:var(--eletra-orange); padding:4px 8px;" onclick="editarCliente('${c.id_doc}')"><i class="fa-solid fa-pen"></i> EDITAR</button>
                </td>
            </tr>`;
        }).join('');
    };

    // Renderiza APENAS OS 50 PRIMEIROS para abrir a tela num piscar de olhos
    let rowsHtml = window.gerarLinhasTabelaClientes(clientes.slice(0, 50));

    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn active" onclick="switchTab('cli-base')">1. Dados Base</button>
                <button class="tab-btn" onclick="switchTab('cli-matriz')">2. Matriz de Recebimento</button>
                <button class="tab-btn" onclick="switchTab('cli-lista')">Catálogo (${clientes.length})</button>
            </div>
            
            <div id="cli-base" class="tab-content active">
                <input type="hidden" id="c-id">
                <fieldset class="prop-group">
                    <legend>Identificação do Ponto de Entrega</legend>
                    <div style="display: grid; grid-template-columns: 1fr 2fr 2fr; gap: 10px;">
                        <div class="form-row-col"><label>CNPJ/CPF*</label><input type="text" id="c-cnpj" placeholder="Apenas números"></div>
                        <div class="form-row-col"><label>Razão Social*</label><input type="text" id="c-razao"></div>
                        <div class="form-row-col"><label>Nome Fantasia (Filial)*</label><input type="text" id="c-fantasia" placeholder="Ex: Loja Matriz, Loja Centro..."></div>
                    </div>
                </fieldset>
                
                <fieldset class="prop-group" style="margin-top:15px;">
                    <legend>Localização Geográfica</legend>
                    <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 10px; margin-bottom:10px;">
                        <div class="form-row-col"><label>Endereço Completo (Gerado Auto)</label><input type="text" id="c-endcompleto" readonly style="background:#222; color:#aaa;"></div>
                        <div class="form-row-col"><label style="color:var(--eletra-aqua); font-weight:bold;"><i class="fa-solid fa-bolt"></i> CEP</label><input type="text" id="c-cep" onblur="buscarCEP()" oninput="gerarEnderecoCompleto()" placeholder="Digite para buscar"></div>
                    </div>
                    <div style="display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 10px;">
                        <div class="form-row-col"><label>Logradouro / Número</label><input type="text" id="c-endereco" oninput="gerarEnderecoCompleto()"></div>
                        <div class="form-row-col"><label>Bairro</label><input type="text" id="c-bairro" oninput="gerarEnderecoCompleto()"></div>
                        <div class="form-row-col"><label>Município (Cidade)</label><input type="text" id="c-cidade" oninput="gerarEnderecoCompleto()"></div>
                        <div class="form-row-col"><label>UF</label><input type="text" id="c-uf" maxlength="2" oninput="gerarEnderecoCompleto()"></div>
                    </div>
                </fieldset>
                <div style="display:flex; justify-content:flex-end; margin-top:15px;">
                    <button class="mark-btn" style="border-color:var(--eletra-orange); color:var(--eletra-orange);" onclick="switchTab('cli-matriz')">AVANÇAR PARA MATRIZ <i class="fa-solid fa-arrow-right"></i></button>
                </div>
            </div>

            <div id="cli-matriz" class="tab-content">
                <fieldset class="prop-group" style="border-color:var(--eletra-orange);">
                    <legend style="color:var(--eletra-orange);"><i class="fa-solid fa-network-wired"></i> Restrições Logísticas de Entrega</legend>
                    
                    <div class="form-row-col" style="margin-bottom:15px;">
                        <label style="color:var(--eletra-aqua);">Veículos Permitidos na Doca desta Filial*</label>
                        <div style="display:flex; gap:15px; flex-wrap:wrap; background:#0B0E11; padding:12px; border-radius:4px; border:1px solid #333;">
                            <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="cli-veic-chk" value="Carreta Baú"> Carreta Baú</label>
                            <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="cli-veic-chk" value="Carreta Sider"> Carreta Sider</label>
                            <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="cli-veic-chk" value="Truck"> Truck</label>
                            <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="cli-veic-chk" value="Toco"> Toco</label>
                            <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="cli-veic-chk" value="VUC"> VUC</label>
                            <label style="color:white; font-size:0.85rem; cursor:pointer;"><input type="checkbox" class="cli-veic-chk" value="Fiorino/Van"> Fiorino/Van</label>
                        </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                        <div class="form-row-col"><label>Aceita Sobreposição?</label><select id="c-sobreposicao" style="background:#0B0E11; border:1px solid #333; color:white; padding:8px;"><option value="SIM">SIM</option><option value="NÃO">NÃO</option></select></div>
                        <div class="form-row-col"><label>Dimensões do Palete (mm)</label><select id="c-palete" style="background:#0B0E11; border:1px solid #333; color:white; padding:8px;"><option value="1000x1200x970">1000 x 1200 x 970 (PBR)</option><option value="1100x1100x970">1100 x 1100 x 970</option><option value="OUTRO">Outro / Sem Restrição</option></select></div>
                    </div>

                    <h4 style="color:var(--text-silver); margin: 20px 0 10px 0; border-bottom:1px solid #333; padding-bottom:5px;">Regras de Agendamento e Janelas</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom:15px;">
                        <div class="form-row-col"><label>Via de Agendamento</label><select id="c-agendamento" style="background:#0B0E11; border:1px solid #333; color:white; padding:8px;"><option value="NÃO">NÃO</option><option value="PORTAL">PORTAL WEB</option><option value="EMAIL">E-MAIL</option><option value="TELEFONE">TELEFONE</option></select></div>
                        <div class="form-row-col"><label>Janela (Início)</label><input type="time" id="c-janela-inicio"></div>
                        <div class="form-row-col"><label>Janela (Fim)</label><input type="time" id="c-janela-fim"></div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom:15px;">
                        <div class="form-row-col"><label>Link do Portal</label><input type="text" id="c-link" placeholder="Ex: https://portal.cliente.com"></div>
                        <div class="form-row-col"><label>E-mails</label><input type="text" id="c-email"></div>
                        <div class="form-row-col"><label>Telefone(s)</label><input type="text" id="c-telefone"></div>
                    </div>
                    <div class="form-row-col"><label>Observações Adicionais</label><textarea id="c-obs" rows="2" style="width:100%; background:#0B0E11; border:1px solid #333; color:white; padding:8px; border-radius:4px;"></textarea></div>
                </fieldset>
                <div class="props-footer" style="margin-top:20px; border:none; padding:0; background:transparent;">
                    <button class="mark-btn action apply" style="width:100%; border-color:#39FF14; color:#39FF14;" onclick="salvarCliente()">SALVAR CADASTRO E MATRIZ</button>
                </div>
            </div>

            <div id="cli-lista" class="tab-content">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; gap:20px; flex-wrap:wrap;">
                    <h3 style="color:var(--eletra-aqua); margin:0;">Pontos de Entrega</h3>
                    
                    <div style="flex:1; max-width:400px; position:relative;">
                        <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:12px; top:10px; color:#888;"></i>
                        <input type="text" id="busca-cli" placeholder="Pesquisar por CNPJ, Nome ou Cidade..." onkeyup="pesquisarClienteMotor()" style="width:100%; padding:8px 10px 8px 35px; background:#111418; border:1px solid #333; color:white; border-radius:4px;">
                    </div>

                    <div>
                        <input type="file" id="csv-cliente" accept=".csv" style="display:none" onchange="importarCSVClientes(event)">
                        <button class="mark-btn action" style="border-color:var(--eletra-orange); color:var(--eletra-orange);" onclick="document.getElementById('csv-cliente').click()"><i class="fa-solid fa-file-csv"></i> IMPORTAR CSV</button>
                    </div>
                </div>
                
                <div style="font-size:0.75rem; color:#888; margin-bottom:10px;">Exibindo máximo de 50 registros simultâneos para otimização de memória. Utilize a busca acima.</div>
                <table class="data-table">
                    <thead><tr><th>CNPJ / CPF</th><th>Nome Fantasia / Razão</th><th>Município / UF</th><th>Logística</th><th>Ações</th></tr></thead>
                    <tbody id="cli-tbody">${rowsHtml}</tbody>
                </table>
            </div>
        </div>
    `;
}

// O MOTOR DE BUSCA (A ser adicionado logo após o renderCliente)
window.pesquisarClienteMotor = function() {
    const termo = document.getElementById('busca-cli').value.toLowerCase().trim();
    const tbody = document.getElementById('cli-tbody');
    
    if(termo.length < 2) {
        // Se apagou a busca, volta a mostrar os primeiros 50 da cache original
        tbody.innerHTML = window.gerarLinhasTabelaClientes(window.clientesCacheEdit.slice(0, 50));
        return;
    }
    
    // Filtra na memória JS (Super rápido e não trava o DOM)
    const filtrados = window.clientesCacheEdit.filter(c => {
        return (c.razaoSocial && c.razaoSocial.toLowerCase().includes(termo)) ||
               (c.nomeFantasia && c.nomeFantasia.toLowerCase().includes(termo)) ||
               (c.cnpj && c.cnpj.includes(termo)) ||
               (c.cidade && c.cidade.toLowerCase().includes(termo));
    });
    
    // Renderiza apenas até 50 dos filtrados no HTML
    tbody.innerHTML = window.gerarLinhasTabelaClientes(filtrados.slice(0, 50));
}

window.gerarEnderecoCompleto = function() {
    const end = document.getElementById('c-endereco').value.trim();
    const bairro = document.getElementById('c-bairro').value.trim();
    const cid = document.getElementById('c-cidade').value.trim();
    const uf = document.getElementById('c-uf').value.trim();
    const cep = document.getElementById('c-cep').value.trim();
    
    let arr = [];
    if(end) arr.push(end);
    if(bairro) arr.push(bairro);
    if(cid) arr.push(cid);
    if(uf) arr.push(uf);
    if(cep) arr.push(`CEP: ${cep}`);
    
    document.getElementById('c-endcompleto').value = arr.join(', ');
}

window.salvarCliente = async function() {
    const id = document.getElementById('c-id').value;
    const cnpj = document.getElementById('c-cnpj').value.replace(/\D/g, '');
    const razao = document.getElementById('c-razao').value.trim();
    
    if(!cnpj || !razao) { notify("CNPJ e Razão Social são obrigatórios.", "error"); return; }
    const veiculosPermitidos = Array.from(document.querySelectorAll('.cli-veic-chk:checked')).map(cb => cb.value);

    const payload = { 
        cnpj: cnpj, razaoSocial: razao, nomeFantasia: document.getElementById('c-fantasia').value.trim(),
        endereco: document.getElementById('c-endereco').value.trim(), bairro: document.getElementById('c-bairro').value.trim(),
        cidade: document.getElementById('c-cidade').value.trim(), uf: document.getElementById('c-uf').value.trim().toUpperCase(),
        cep: document.getElementById('c-cep').value.trim(), enderecoCompleto: document.getElementById('c-endcompleto').value.trim(),
        veiculosPermitidos: veiculosPermitidos, 
        aceitaSobreposicao: document.getElementById('c-sobreposicao').value,
        dimensaoPalete: document.getElementById('c-palete').value,
        exigeAgendamento: document.getElementById('c-agendamento').value, 
        janelaInicio: document.getElementById('c-janela-inicio').value,
        janelaFim: document.getElementById('c-janela-fim').value,
        linkPortal: document.getElementById('c-link').value.trim(),
        emailsContato: document.getElementById('c-email').value.trim(),
        telefonesContato: document.getElementById('c-telefone').value.trim(),
        observacoes: document.getElementById('c-obs').value.trim(),
        atualizadoEm: new Date().toISOString() 
    };
    
    try {
        if (id) { await db.collection('clientes').doc(id).update(payload); notify("Cadastro atualizado!", "success"); } 
        else { await db.collection('clientes').doc().set(payload); notify("Novo ponto de entrega catalogado!", "success"); }
        renderCliente(document.getElementById('workspace'));
    } catch(e) { notify("Erro ao salvar.", "error"); }
}

window.editarCliente = function(id) {
    const c = window.clientesCacheEdit.find(x => x.id_doc === id);
    if(!c) return;
    
    document.getElementById('c-id').value = c.id_doc;
    document.getElementById('c-cnpj').value = formatarCnpjCpf(c.cnpj || '');
    document.getElementById('c-razao').value = c.razaoSocial || '';
    document.getElementById('c-fantasia').value = c.nomeFantasia || '';
    document.getElementById('c-endereco').value = c.endereco || '';
    document.getElementById('c-bairro').value = c.bairro || '';
    document.getElementById('c-cidade').value = c.cidade || '';
    document.getElementById('c-uf').value = c.uf || '';
    document.getElementById('c-cep').value = c.cep || '';
    document.getElementById('c-endcompleto').value = c.enderecoCompleto || '';

    // Aba 2 (Matriz)
    document.querySelectorAll('.cli-veic-chk').forEach(chk => { chk.checked = c.veiculosPermitidos && c.veiculosPermitidos.includes(chk.value); });
    document.getElementById('c-sobreposicao').value = c.aceitaSobreposicao || 'SIM';
    document.getElementById('c-palete').value = c.dimensaoPalete || '1000x1200x970';
    document.getElementById('c-agendamento').value = c.exigeAgendamento || 'NÃO';
    document.getElementById('c-janela-inicio').value = c.janelaInicio || '';
    document.getElementById('c-janela-fim').value = c.janelaFim || '';
    document.getElementById('c-link').value = c.linkPortal || '';
    document.getElementById('c-email').value = c.emailsContato || '';
    document.getElementById('c-telefone').value = c.telefonesContato || '';
    document.getElementById('c-obs').value = c.observacoes || '';

    switchTab('cli-base');
}

/* =========================================
   MÓDULO DE PLANEJAMENTO: ROTEIRIZADOR & GEOLOCALIZAÇÃO
   ========================================= */
window.renderRoteirizador = async function(container) {
    container.innerHTML = `
        <div class="props-container" style="height:auto; min-height:650px;">
            <div class="props-tabs">
                <button class="tab-btn" onclick="switchTab('rot-mapa')">1. Painel de Rotas</button>
                <button class="tab-btn active" onclick="switchTab('rot-geo')">2. Geolocalização (OSRM / Nominatim)</button>
            </div>
            
            <div id="rot-mapa" class="tab-content">
                <div class="card" style="text-align:center; padding: 50px;">
                    <i class="fa-solid fa-map-location-dot fa-3x" style="color:#555; margin-bottom:15px;"></i>
                    <h3 style="color:#aaa;">Motor de Roteirização em Construção</h3>
                    <p style="color:#777; font-size:0.85rem;">Em breve: Visualização de polígonos e consolidação de frota no mapa.</p>
                </div>
            </div>

            <div id="rot-geo" class="tab-content active">
                <fieldset class="prop-group" style="border-color:var(--eletra-aqua);">
                    <legend style="color:var(--eletra-aqua);"><i class="fa-solid fa-satellite-dish"></i> Validador de Coordenadas Lat/Lng</legend>
                    <p style="font-size:0.8rem; color:#888; margin-bottom:15px;">Valide o CEP ou Endereço do cliente contra a base OpenStreetMap para garantir a precisão da rota.</p>
                    
                    <div style="display:grid; grid-template-columns: 3fr 1fr; gap:10px; margin-bottom:15px;">
                        <input type="text" id="geo-query" placeholder="Digite o Endereço completo, Cidade ou CEP (Ex: Av Paulista, SP)" style="padding:10px; font-size:1rem;">
                        <button class="mark-btn action apply" style="border-color:#39FF14; color:#39FF14;" onclick="validarGeolocalizacao()">
                            <i class="fa-solid fa-magnifying-glass"></i> BUSCAR COORDENADAS
                        </button>
                    </div>

                    <div id="geo-resultados" style="display:none; background:#0B0E11; border:1px solid #333; padding:15px; border-radius:6px;">
                        <h4 style="color:var(--eletra-orange); margin-bottom:10px;">Resultado OSRM / Nominatim</h4>
                        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px;">
                            <div>
                                <label style="color:#aaa; font-size:0.75rem;">Endereço Normalizado (Standard)</label>
                                <div id="geo-address" style="color:white; font-size:0.9rem; background:#1A1D21; padding:10px; border-radius:4px; margin-top:5px;">-</div>
                            </div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
                                <div>
                                    <label style="color:#aaa; font-size:0.75rem;">Latitude</label>
                                    <div id="geo-lat" style="color:#39FF14; font-weight:bold; font-size:1.1rem; background:#1A1D21; padding:10px; border-radius:4px; margin-top:5px; text-align:center;">-</div>
                                </div>
                                <div>
                                    <label style="color:#aaa; font-size:0.75rem;">Longitude</label>
                                    <div id="geo-lon" style="color:#00D4FF; font-weight:bold; font-size:1.1rem; background:#1A1D21; padding:10px; border-radius:4px; margin-top:5px; text-align:center;">-</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </fieldset>
            </div>
        </div>
    `;
}

// INTEGRAÇÃO OPEN-SOURCE (NOMINATIM / OSRM)
window.validarGeolocalizacao = async function() {
    const query = document.getElementById('geo-query').value.trim();
    if (!query) { notify("Digite um endereço ou CEP para buscar.", "error"); return; }
    
    document.getElementById('geo-resultados').style.display = 'block';
    document.getElementById('geo-address').innerText = "Processando satélite...";
    document.getElementById('geo-lat').innerText = "...";
    document.getElementById('geo-lon').innerText = "...";

    try {
        // Chamada direta à API pública e open-source do OpenStreetMap
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`);
        const data = await response.json();

        if (data && data.length > 0) {
            const result = data[0];
            document.getElementById('geo-address').innerText = result.display_name;
            document.getElementById('geo-lat').innerText = parseFloat(result.lat).toFixed(6);
            document.getElementById('geo-lon').innerText = parseFloat(result.lon).toFixed(6);
            notify("Coordenadas geográficas capturadas com sucesso!", "success");
        } else {
            document.getElementById('geo-address').innerText = "Endereço não localizado pelo satélite.";
            document.getElementById('geo-lat').innerText = "N/A";
            document.getElementById('geo-lon').innerText = "N/A";
            notify("Não foi possível geocodificar o local.", "error");
        }
    } catch (e) {
        console.error("Erro no Geocoding OSRM:", e);
        notify("Falha na comunicação com o servidor de mapas.", "error");
    }
}

// ==========================================
// O MOTOR DE IMPORTAÇÃO HEURÍSTICA DE CSV
// ==========================================
window.importarCSVClientes = function(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        const text = e.target.result;
        const lines = text.split('\n');
        if (lines.length < 2) { notify("O CSV parece vazio.", "error"); return; }
        
        let batchArray = [db.batch()];
        let count = 0;
        let currentBatchIndex = 0;

        // Função interna de Engenharia Reversa (Desmembra a string de Endereço Alternativo)
        function parseEnderecoAlternativo(fullText) {
            let res = { endereco: '', bairro: '', municipio: '', uf: '', cep: '' };
            if (!fullText) return res;
            
            // 1. Caça ao CEP (Qualquer lugar da string)
            const cepMatch = fullText.match(/\b\d{5}-?\d{3}\b/);
            if (cepMatch) { 
                res.cep = cepMatch[0]; 
                fullText = fullText.replace(cepMatch[0], '').replace(/CEP:?/i, '').trim(); 
            }
            
            // 2. Caça à UF (Procura as siglas exatas dos estados cercadas por espaços/vírgulas)
            const ufs = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
            const ufRegex = new RegExp(`\\b(${ufs.join('|')})\\b`, 'i');
            const ufMatch = fullText.match(ufRegex);
            if (ufMatch) { 
                res.uf = ufMatch[1].toUpperCase(); 
                fullText = fullText.replace(new RegExp(`\\s*-\\s*${res.uf}\\b|\\b${res.uf}\\b`, 'i'), '').trim(); 
            }
            
            // Limpa sujos e separadores esquecidos
            fullText = fullText.replace(/[\s,\-]+$/, '').replace(/\s+/g, ' ');

            // 3. Tenta quebrar por vírgulas o que sobrou (Rua, Bairro, Cidade)
            let parts = fullText.split(',').map(p => p.trim()).filter(p => p);
            
            if (parts.length === 1) {
                res.endereco = parts[0];
            } else if (parts.length === 2) {
                res.endereco = parts[0]; res.municipio = parts[1];
            } else {
                // Assume que o último bloco é a Cidade, o penúltimo é o Bairro, e o resto é a Rua
                res.municipio = parts.pop();
                res.bairro = parts.pop();
                res.endereco = parts.join(', '); 
            }
            return res;
        }

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            let data = lines[i].split(';'); 
            
            let cnpj = data[0] ? data[0].replace(/\D/g, '') : '';
            if(!cnpj) continue;

            let nome = data[3] ? data[3].trim() : '';
            let fantasiaBase = data[4] ? data[4].trim() : nome;
            
            // DADOS PRINCIPAIS (A MATRIZ)
            let end = data[5] ? data[5].trim() : '';
            let bairro = data[6] ? data[6].trim() : '';
            let cep = data[7] ? data[7].trim() : '';
            let uf = data[8] ? data[8].trim().toUpperCase() : '';
            let mun = data[9] ? data[9].trim() : '';
            
            let endCompletoArr = [];
            if(end) endCompletoArr.push(end);
            if(bairro) endCompletoArr.push(bairro);
            if(mun) endCompletoArr.push(mun);
            if(uf) endCompletoArr.push(uf);
            if(cep) endCompletoArr.push(`CEP: ${cep}`);
            let endCompleto = endCompletoArr.join(', ');

            // REGISTO 1: A MATRIZ
            const docRef1 = db.collection('clientes').doc(); // Auto-ID para aceitar mesmos CNPJs
            batchArray[currentBatchIndex].set(docRef1, {
                cnpj: cnpj, razaoSocial: nome, nomeFantasia: fantasiaBase,
                endereco: end, bairro: bairro, cidade: mun, uf: uf, cep: cep,
                enderecoCompleto: endCompleto,
                veiculosPermitidos: ['Carreta Baú', 'Carreta Sider', 'Truck', 'Toco', 'VUC', 'Fiorino/Van'],
                aceitaSobreposicao: 'SIM', atualizadoEm: new Date().toISOString()
            });

            count++;
            if (count % 490 === 0) { currentBatchIndex++; batchArray.push(db.batch()); }

            // REGISTOS FILIAIS (Colunas de 17 a 20)
            const colsAlt = [17, 18, 19, 20];
            colsAlt.forEach((colIdx, j) => {
                let endAltStr = data[colIdx] ? data[colIdx].trim() : '';
                if (endAltStr) {
                    let parsed = parseEnderecoAlternativo(endAltStr);
                    const docRefAlt = db.collection('clientes').doc(); 
                    
                    batchArray[currentBatchIndex].set(docRefAlt, {
                        cnpj: cnpj, razaoSocial: nome, 
                        nomeFantasia: `${fantasiaBase} (End ${j + 2})`,
                        endereco: parsed.endereco || endAltStr,
                        bairro: parsed.bairro, cidade: parsed.municipio, uf: parsed.uf, cep: parsed.cep,
                        enderecoCompleto: endAltStr, // Guarda o texto puro do Excel por segurança
                        veiculosPermitidos: ['Carreta Baú', 'Carreta Sider', 'Truck', 'Toco', 'VUC', 'Fiorino/Van'],
                        aceitaSobreposicao: 'SIM', atualizadoEm: new Date().toISOString()
                    });

                    count++;
                    if (count % 490 === 0) { currentBatchIndex++; batchArray.push(db.batch()); }
                }
            });
        }

        try {
            document.getElementById('workspace').innerHTML = `<div style="color:white; padding:20px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Desmembrando endereços e salvando no Firebase...</div>`;
            for (let b of batchArray) { await b.commit(); }
            notify(`Sucesso! ${count} localidades registadas a partir do CSV.`, "success");
            renderCliente(document.getElementById('workspace'));
        } catch (error) {
            console.error("Erro na importação em lote:", error);
            notify("Erro ao gravar clientes.", "error");
        }
    };
    reader.readAsText(file, 'latin1'); // Usa latin1 para respeitar a acentuação do Excel em português
    event.target.value = ''; 
}

window.autoFillClienteOutbound = function(input) {
    if(!window.clientesCache) return;
    const valorDigitado = input.value.toUpperCase();
    const clienteEncontrado = window.clientesCache.find(c => c.razao && c.razao.toUpperCase() === valorDigitado);
    
    if (clienteEncontrado) {
        document.getElementById('out-uf').value = clienteEncontrado.uf;
        
        // Alerta visual de restrições de entrega para o operador
        if (clienteEncontrado.restricoes) {
            const r = clienteEncontrado.restricoes;
            notify(`RESTRIÇÃO ${clienteEncontrado.uf}: Horário: ${r.horario}. Carreta: ${r.carretaBau}. Caminhão: ${r.truck}.`, "info");
        }
    } else {
        document.getElementById('out-uf').value = '';
    }
}

window.salvarNovoAditivo = async function() {
    const viagemData = document.getElementById('ad-viagem').value;
    const natureza = document.getElementById('ad-natureza').value;
    const valor = parseFloat(document.getElementById('ad-valor').value);
    const justificativa = document.getElementById('ad-justificativa').value.trim();

    if(!viagemData || !natureza || !valor || !justificativa) {
        notify("Preencha todos os campos obrigatórios (*)", "error");
        return;
    }

    if(justificativa.length < 15) {
        notify("A justificativa é muito curta. Descreva melhor.", "error");
        return;
    }

    const [oe, transp, uf] = viagemData.split('|');

    const payload = {
        oe: oe,
        transportadora: transp,
        destinoUF: uf,
        natureza: natureza,
        valorPleiteado: valor,
        justificativa: justificativa,
        solicitante: CURRENT_USER.name,
        status: 'PENDENTE',
        dataCriacao: new Date().toISOString()
    };

    if(!confirm(`Confirmar o envio deste pleito de R$ ${valor.toLocaleString('pt-BR')}?`)) return;

    const res = await StorageManager.saveAditivo(payload);
    if(res.success) {
        notify("Pleito registado e enviado para o Tribunal Financeiro!", "success");
        renderAditivos(document.getElementById('workspace'));
    }
}

window.julgarAditivo = async function(id_doc, decisao) {
    let justificativaGestor = "";
    if (decisao === 'REPROVADO') {
        justificativaGestor = prompt("Motivo da Glosa / Reprovação:");
        if (justificativaGestor === null || justificativaGestor.trim() === "") {
            notify("A justificação é obrigatória para glosas.", "error");
            return;
        }
    } else {
        if(!confirm("Aprovar este custo extra? O valor integrará a fatura da transportadora.")) return;
        justificativaGestor = "Aprovado conforme regras contratuais.";
    }

    const res = await StorageManager.updateAditivoTratativa(id_doc, decisao, justificativaGestor);
    if(res.success) {
        notify(`Aditivo ${decisao} com sucesso!`);
        renderAditivos(document.getElementById('workspace'));
    }
}

let transportadorasCache = [];

async function carregarDropdownTransportadoras() {
    transportadorasCache = await StorageManager.getTransportadoras();
    
    let dataListCnpj = document.getElementById('lista-transportadoras-cnpj');
    if (!dataListCnpj) {
        dataListCnpj = document.createElement('datalist');
        dataListCnpj.id = 'lista-transportadoras-cnpj';
        document.body.appendChild(dataListCnpj);
    }
    dataListCnpj.innerHTML = transportadorasCache.map(t => `<option value="${t.cnpj}">${t.razao}</option>`).join('');
    
    let dataListNome = document.getElementById('lista-transportadoras-nome');
    if (!dataListNome) {
        dataListNome = document.createElement('datalist');
        dataListNome.id = 'lista-transportadoras-nome';
        document.body.appendChild(dataListNome);
    }
    dataListNome.innerHTML = transportadorasCache.map(t => `<option value="${t.razao}">${t.cnpj}</option>`).join('');
}

window.autoFillTransportadora = function(inputElement, tipoBusca) {
    const valorDigitado = inputElement.value.trim().toUpperCase();
    const rawDigitado = inputElement.value.replace(/\D/g, '');
    const campoNome = document.getElementById('input-transp');
    const campoCnpj = document.getElementById('input-cnpj-transp');
    
    let transportadoraEncontrada = null;
    if (tipoBusca === 'cnpj' && rawDigitado.length >= 11) {
        transportadoraEncontrada = transportadorasCache.find(t => t.cnpj === rawDigitado);
        if (transportadoraEncontrada) campoNome.value = transportadoraEncontrada.razao;
    } else if (tipoBusca === 'nome' && valorDigitado.length > 3) {
        transportadoraEncontrada = transportadorasCache.find(t => t.razao && t.razao.toUpperCase() === valorDigitado);
        if (transportadoraEncontrada) {
            campoCnpj.value = transportadoraEncontrada.cnpj;
            applyCpfCnpjMask(campoCnpj);
        }
    }
}

function clearData() {StorageManager.clearData();}