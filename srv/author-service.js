import cds from '@sap/cds';

export default cds.service.impl(async function () {
  const { MyTutorials } = this.entities;

  this.before('READ', MyTutorials, (req) => {
    const userId = req.user?.id;
    if (!userId || userId === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    req.query.where({ ownerUserId: userId });
  });
});
